import { randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { applyOperationSchema, operationIdSchema } from "../shared/apply";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.strictObject({
  hostId: z.string().min(1).max(512), installation: z.string().min(1).max(128),
  instance: hash, requestHash: hash, receiptHash: hash, settledAt: z.number().int().nonnegative().optional(), operation: applyOperationSchema,
});
export type ApplyJournalRecord = z.infer<typeof recordSchema>;
const maxRecords = 64;
export const terminalRetentionMs = 24 * 60 * 60 * 1000;
const expirable = (phase: ApplyJournalRecord["operation"]["phase"]) =>
  phase === "completed" || phase === "failed_before_write" || phase === "partial_failure";
const maxBytes = 2 * 1024 * 1024;
const namePattern = /^[0-9a-f]{32,64}\.json$/;

export class ApplyJournal {
  private readonly identity;

  constructor(readonly directory: string, private readonly now = Date.now) {
    this.identity = lstatSync(directory, { bigint: true });
    this.checkDirectory();
  }

  private checkDirectory() {
    const node = lstatSync(this.directory, { bigint: true });
    if (!node.isDirectory() || node.dev !== this.identity.dev || node.ino !== this.identity.ino ||
        node.uid !== BigInt(process.getuid!()) || (node.mode & 0o7777n) !== 0o700n ||
        realpathSync(this.directory) !== this.directory) throw new Error("journal_unavailable");
  }

  private syncDirectory() {
    this.checkDirectory();
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const node = fstatSync(fd, { bigint: true });
      if (node.dev !== this.identity.dev || node.ino !== this.identity.ino) throw new Error("journal_unavailable");
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }

  read(id: string): ApplyJournalRecord | undefined {
    const entry = this.readEntry(id);
    return entry && !this.expired(entry, this.now()) ? entry.record : undefined;
  }

  private expired(entry: { record: ApplyJournalRecord; mtimeMs: number }, now: number) {
    const { record, mtimeMs } = entry;
    return expirable(record.operation.phase) && now - (record.settledAt ?? mtimeMs) >= terminalRetentionMs;
  }

  private readEntry(id: string) {
    const path = join(this.directory, operationIdSchema.parse(id) + ".json");
    this.checkDirectory();
    let fd;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      // link + unlink admission can leave a second private link if the process dies.
      if (!stat.isFile() || stat.nlink > 2 || stat.uid !== process.getuid!() ||
          (stat.mode & 0o7777) !== 0o600 || stat.size > maxBytes) throw new Error("journal_unavailable");
      const bytes = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, size);
        if (!count) break;
        size += count;
      }
      if (size !== stat.size) throw new Error("journal_unavailable");
      const record = recordSchema.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")));
      if (record.operation.operationId !== id) throw new Error("journal_unavailable");
      this.syncDirectory();
      return { record, mtimeMs: stat.mtimeMs };
    } finally { closeSync(fd); }
  }

  // Called while the helper owns the daemon-wide lease. The admission record is
  // also the receipt claim. A contender sees both or neither.
  checkAdmission(record: ApplyJournalRecord): "receipt_consumed" | "journal_full" | undefined {
    this.checkDirectory();
    const names = readdirSync(this.directory);
    const records = names.filter(name => namePattern.test(name));
    const now = this.now();
    let pruned = 0;
    let claimed = false;
    try {
      for (const name of records) {
        const current = this.readEntry(name.slice(0, -5));
        if (!current) throw new Error("journal_unavailable");
        if (this.expired(current, now)) {
          this.checkDirectory();
          unlinkSync(join(this.directory, name));
          pruned++;
        } else if (current.record.receiptHash === record.receiptHash) {
          claimed = true;
        }
      }
    } finally {
      if (pruned) this.syncDirectory();
    }
    if (claimed) return "receipt_consumed";
    if (names.length - pruned >= maxRecords + 1 || records.length - pruned >= maxRecords) return "journal_full";
  }

  publish(record: ApplyJournalRecord, admission = false) {
    this.checkDirectory();
    const stored = expirable(record.operation.phase) ? { ...record, settledAt: this.now() } : record;
    const bytes = Buffer.from(JSON.stringify(recordSchema.parse(stored)));
    if (bytes.length > maxBytes) throw new Error("journal_full");
    const path = join(this.directory, record.operation.operationId + ".json");
    const temporary = join(this.directory, ".pending-" + randomBytes(16).toString("hex"));
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      this.checkDirectory();
      if (admission) linkSync(temporary, path);
      else renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.syncDirectory();
  }
}
