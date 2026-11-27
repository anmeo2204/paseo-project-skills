// M4.3 fixture-only anchored writer. No receipt claim, journal or product RPC.
#import <Foundation/Foundation.h>
#include <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/file.h>
#include <sys/acl.h>
#include <sys/resource.h>
#include <sys/select.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <math.h>
#include <limits.h>
#include <time.h>
#ifndef PPS_TESTING
#define PPS_TESTING 0
#endif
#define VERSION @"m4.3-fixture.1"
#define MAX_FILES 2048
#define MAX_DIRS 1024
#define MAX_OBS 32768
#define MAX_SOURCE (8*1024*1024)
#define MAX_WIRE (24*1024*1024)

@interface PPSDir : NSObject
@property NSString *path;
@property NSString *name;
@property int fd;
@property NSInteger parent;
@property struct stat identity;
@property BOOL created;
@property NSMutableDictionary *ledger;
@end
@implementation PPSDir
@end
@interface PPSFile : NSObject
@property NSDictionary *input;
@property BOOL modeFinal;
@property NSData *bytes;
@property NSString *destination;
@property PPSDir *parent;
@property NSString *name;
@property struct stat identity;
@property NSMutableDictionary *ledger;
@end
@implementation PPSFile
@end

static NSMutableArray<PPSDir *> *dirs;
static NSMutableDictionary<NSString *, PPSDir *> *dirByPath;
static NSMutableArray<PPSFile *> *files;
static NSMutableArray<NSMutableDictionary *> *ledger;
static NSArray *observations;
static NSDictionary *request;
static NSDictionary *controls;
static NSMutableSet *usedBarriers;
static NSMutableData *inputBuffer;
static NSString *rootPath;
static PPSDir *rootNode;
static int coordinatorFd = -1;
static PPSDir *coordinatorNode;
static struct stat coordinatorIdentity;
static BOOL mutated = NO, parentGone = NO, uncertain = NO;
static pid_t expectedParent;
static double deadline;
static NSString *errorCode;
static NSUInteger barrierSequence __attribute__((unused)), syscallCount;

static double monotonic(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
static BOOL fail(NSString *code) { if (!errorCode) errorCode = code; return NO; }
static BOOL emit(NSDictionary *event) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:NSJSONWritingSortedKeys error:nil];
    if (!data) return fail(@"protocol_error");
    const uint8_t *p = data.bytes; size_t left = data.length;
    while (left) { ssize_t n = write(STDOUT_FILENO, p, left); if (n < 0 && errno == EINTR) continue; if (n <= 0) { parentGone = YES; return fail(@"parent_gone"); } p += n; left -= n; }
    if (write(STDOUT_FILENO, "\n", 1) != 1) { parentGone = YES; return fail(@"parent_gone"); }
    return YES;
}
static BOOL checkpoint(void) {
    if (getppid() != expectedParent || parentGone) return fail(@"parent_gone");
    if (monotonic() >= deadline) return fail(@"deadline_exceeded");
    if (++syscallCount > 100000) return fail(@"limit_exceeded");
    return YES;
}
static NSData *readLine(void) {
    while (checkpoint()) {
        const uint8_t *p = inputBuffer.bytes;
        const uint8_t *end = memchr(p, '\n', inputBuffer.length);
        if (end) {
            NSUInteger n = (NSUInteger)(end - p); NSData *line = [inputBuffer subdataWithRange:NSMakeRange(0, n)];
            [inputBuffer replaceBytesInRange:NSMakeRange(0, n + 1) withBytes:NULL length:0]; return line;
        }
        if (inputBuffer.length > MAX_WIRE) { fail(@"limit_exceeded"); return nil; }
        fd_set ready; FD_ZERO(&ready); FD_SET(STDIN_FILENO, &ready); struct timeval wait = {0, 100000};
        int r = select(STDIN_FILENO + 1, &ready, NULL, NULL, &wait);
        if (r < 0 && errno == EINTR) continue;
        if (r < 0) { fail(@"protocol_error"); return nil; }
        if (!r) continue;
        uint8_t bytes[8192]; ssize_t n = read(STDIN_FILENO, bytes, sizeof(bytes));
        if (n <= 0) { parentGone = YES; fail(@"parent_gone"); return nil; }
        [inputBuffer appendBytes:bytes length:(NSUInteger)n];
    }
    return nil;
}
static BOOL barrier(NSString *point, NSString *destination) {
#if PPS_TESTING
    for (NSDictionary *b in controls[@"barriers"] ?: @[]) {
        NSString *key = [NSString stringWithFormat:@"%@:%@", point, destination ?: @""];
        if (![b[@"point"] isEqual:point] || (b[@"destination"] && ![b[@"destination"] isEqual:destination]) || [usedBarriers containsObject:key]) continue;
        [usedBarriers addObject:key]; barrierSequence++;
        if (!emit(@{@"event":@"barrier", @"point":point, @"destination":destination ?: @"", @"sequence":@(barrierSequence), @"pid":@(getpid())})) return NO;
        NSData *line = readLine(); if (!line) return NO;
        NSString *ack = [[NSString alloc] initWithData:line encoding:NSUTF8StringEncoding];
        if (![ack isEqual:[NSString stringWithFormat:@"CONTINUE %lu", (unsigned long)barrierSequence]]) return fail(@"protocol_error");
    }
#else
    (void)point; (void)destination;
#endif
    return checkpoint();
}
static NSDictionary *fault(NSString *point, NSString *destination) {
#if PPS_TESTING
    for (NSDictionary *f in controls[@"faults"] ?: @[]) if ([f[@"point"] isEqual:point] && [f[@"destination"] isEqual:destination]) return f;
#else
    (void)point; (void)destination;
#endif
    return nil;
}
static BOOL stringValue(id value) { return [value isKindOfClass:NSString.class] && [value UTF8String] && !memchr([value UTF8String], 0, [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding]); }
static BOOL keys(NSDictionary *value, NSArray *required, NSArray *optional) {
    if (![value isKindOfClass:NSDictionary.class]) return NO;
    for (id key in required) if (!value[key]) return NO;
    for (id key in value) if (![required containsObject:key] && ![optional containsObject:key]) return NO;
    return YES;
}
static BOOL integer(id value, unsigned long long max) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
        isfinite([value doubleValue]) && [value doubleValue] >= 0 && floor([value doubleValue]) == [value doubleValue] && [value doubleValue] <= max;
}
static BOOL decimalEqual(id value, unsigned long long actual) {
    if (!stringValue(value) || ![value length]) return NO;
    for (const char *p = [value UTF8String]; *p; p++) if (*p < '0' || *p > '9') return NO;
    errno = 0; unsigned long long n = strtoull([value UTF8String], NULL, 10); return !errno && n == actual;
}
static BOOL timeEqual(id value, struct timespec time) {
    return stringValue(value) && [value isEqual:[NSString stringWithFormat:@"%lld", (long long)time.tv_sec * 1000000000LL + time.tv_nsec]];
}
static NSString *sha(NSData *data) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    char text[65]; for (int i=0;i<32;i++) snprintf(text+i*2,3,"%02x",digest[i]); text[64]=0; return [NSString stringWithUTF8String:text];
}
static BOOL absolute(NSString *path) {
    return stringValue(path) && [path hasPrefix:@"/"] && [path lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= 4096 &&
        ![path containsString:@"//"] && ![[path componentsSeparatedByString:@"/"] containsObject:@".."] &&
        ![[path componentsSeparatedByString:@"/"] containsObject:@"."] && ([path isEqual:@"/"] || ![path hasSuffix:@"/"]);
}
static BOOL beneath(NSString *path, NSString *base) { return [path hasPrefix:[base stringByAppendingString:@"/"]]; }
static BOOL portable(NSString *path, BOOL writePath) {
    if (!stringValue(path) || !path.length || [path lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 1024) return NO;
    NSArray *parts = [path componentsSeparatedByString:@"/"]; if (parts.count > 32) return NO;
    NSCharacterSet *bad = [NSCharacterSet characterSetWithCharactersInString:@"\\:"];
    for (NSString *part in parts) {
        NSString *lower = part.lowercaseString;
        if (!part.length || [part isEqual:@"."] || [part isEqual:@".."] || [lower isEqual:@".git"] ||
            [part rangeOfCharacterFromSet:bad].location != NSNotFound || [part rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound ||
            [part hasSuffix:@"."] || [part hasSuffix:@" "]) return NO;
        NSString *stem = [[lower componentsSeparatedByString:@"."] firstObject];
        if ([@[@"con",@"prn",@"aux",@"nul",@"com1",@"com2",@"com3",@"com4",@"com5",@"com6",@"com7",@"com8",@"com9",@"lpt1",@"lpt2",@"lpt3",@"lpt4",@"lpt5",@"lpt6",@"lpt7",@"lpt8",@"lpt9"] containsObject:stem]) return NO;
    }
    if (writePath) {
        if (![@[@".agents",@".kiro"] containsObject:parts[0]]) return NO;
        if (parts.count > 1 && ![parts[1] isEqual:@"skills"]) return NO;
        if (parts.count > 2) {
            NSString *slug = parts[2]; NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"^[a-z0-9]+(?:-[a-z0-9]+)*$" options:0 error:nil];
            if (slug.length > 64 || [re numberOfMatchesInString:slug options:0 range:NSMakeRange(0,slug.length)] != 1) return NO;
        }
    }
    return YES;
}
static BOOL sameNode(struct stat a, struct stat b) {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_uid == b.st_uid && a.st_gid == b.st_gid;
}
static BOOL emptyAcl(int fd) {
    errno=0;acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);
    if(!acl)return errno==ENOENT ? YES : fail(@"unsupported_permissions");
    acl_entry_t entry;int rc=acl_get_entry(acl,ACL_FIRST_ENTRY,&entry),saved=errno;acl_free(acl);
    return rc<0 && (saved==EINVAL||saved==ENOENT) ? YES : fail(@"unsupported_permissions");
}
static BOOL safeDirectory(int fd, struct stat st, BOOL target) {
    if (!S_ISDIR(st.st_mode)) return fail(@"unsafe_entry");
    if (target) {
        if (st.st_dev != rootNode.identity.st_dev || st.st_uid != getuid() || (st.st_mode & 07022) || st.st_flags & (UF_IMMUTABLE|UF_APPEND|SF_IMMUTABLE|SF_APPEND)) return fail(@"unsupported_permissions");
        if(!emptyAcl(fd))return NO;
    }
    return YES;
}
static PPSDir *directory(NSString *path) {
    PPSDir *cached = dirByPath[path]; if (cached) return cached;
    if (dirs.count >= MAX_DIRS || !checkpoint()) { fail(@"limit_exceeded"); return nil; }
    PPSDir *node = [PPSDir new]; node.path = path; node.fd = -1; node.parent = -1; node.name = @"";
    if ([path isEqual:@"/"]) node.fd = open("/", O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    else {
        PPSDir *parent = directory(path.stringByDeletingLastPathComponent); if (!parent) return nil;
        node.parent = [dirs indexOfObjectIdenticalTo:parent]; node.name = path.lastPathComponent;
        if (parent.fd >= 0) {
            node.fd = openat(parent.fd, node.name.fileSystemRepresentation, O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
            if (node.fd < 0 && errno != ENOENT) { fail(@"unsafe_entry"); return nil; }
        }
    }
    if (node.fd >= 0) {
        struct stat current;
        if (fstat(node.fd, &current) || !S_ISDIR(current.st_mode)) { close(node.fd); fail(@"unsafe_entry"); return nil; }
        node.identity = current;
        if (node.parent >= 0) {
            struct stat linked; PPSDir *parent = dirs[(NSUInteger)node.parent];
            if (fstatat(parent.fd,node.name.fileSystemRepresentation,&linked,AT_SYMLINK_NOFOLLOW) || !sameNode(current,linked)) { close(node.fd); fail(@"linkage_changed"); return nil; }
        }
    }
    [dirs addObject:node]; dirByPath[path] = node; return node;
}
static BOOL coordinatorLinked(void) {
    if(coordinatorFd<0)return YES;
    if(coordinatorNode && (!emptyAcl(coordinatorNode.fd)||!emptyAcl(coordinatorFd)))return NO;
    struct stat current,linked;
    if(fstat(coordinatorFd,&current) || !S_ISREG(current.st_mode) || current.st_nlink!=1 || !sameNode(current,coordinatorIdentity) ||
       fstatat(coordinatorNode.fd,"writer.lock",&linked,AT_SYMLINK_NOFOLLOW) || !sameNode(current,linked)) return fail(@"coordinator_changed");
    for(PPSDir *node in dirs) if(node.fd>=0 && ([node.path isEqual:@"/"] || [node.path isEqual:coordinatorNode.path] || beneath(coordinatorNode.path,node.path))) {
        struct stat st; if(fstat(node.fd,&st)||!sameNode(st,node.identity))return fail(@"coordinator_changed");
        if(node.parent>=0){PPSDir *parent=dirs[(NSUInteger)node.parent];if(parent.fd<0||fstatat(parent.fd,node.name.fileSystemRepresentation,&st,AT_SYMLINK_NOFOLLOW)||!sameNode(st,node.identity))return fail(@"coordinator_changed");}
    }
    return YES;
}
static BOOL linkage(void) {
    if (!checkpoint() || !coordinatorLinked()) return NO;
    for (PPSDir *node in dirs) if (node.fd >= 0) {
        struct stat current;
        if (fstat(node.fd,&current) || !sameNode(node.identity,current)) return fail(@"linkage_changed");
        if (rootNode && ([node.path isEqual:rootPath] || beneath(node.path,rootPath)) && !safeDirectory(node.fd,current,YES)) return NO;
        if (node.parent >= 0) {
            PPSDir *parent = dirs[(NSUInteger)node.parent]; struct stat linked;
            if (parent.fd < 0 || fstatat(parent.fd,node.name.fileSystemRepresentation,&linked,AT_SYMLINK_NOFOLLOW) || !sameNode(node.identity,linked)) return fail(@"linkage_changed");
        }
    }
    return YES;
}
static BOOL observe(NSDictionary *item) {
    NSString *path = item[@"path"]; NSDictionary *expected = item[@"observation"];
    struct stat current; int rc;
    if ([path isEqual:@"/"]) { PPSDir *anchor=directory(@"/"); if (!anchor) return NO; rc=fstat(anchor.fd,&current); }
    else {
        PPSDir *parent=directory(path.stringByDeletingLastPathComponent); if (!parent) return NO;
        if (parent.fd < 0) { rc=-1; errno=ENOENT; }
        else rc=fstatat(parent.fd,path.lastPathComponent.fileSystemRepresentation,&current,AT_SYMLINK_NOFOLLOW);
    }
    if ([expected[@"state"] isEqual:@"absent"]) return rc < 0 && errno==ENOENT ? YES : fail(@"observation_changed");
    if (![expected[@"state"] isEqual:@"present"] || rc) return fail(@"observation_changed");
    BOOL isDirectory=[expected[@"kind"] isEqual:@"directory"];
    if ((isDirectory ? !S_ISDIR(current.st_mode) : ![expected[@"kind"] isEqual:@"file"] || !S_ISREG(current.st_mode) || current.st_nlink != 1) ||
        !decimalEqual(expected[@"dev"],current.st_dev) || !decimalEqual(expected[@"ino"],current.st_ino) || !decimalEqual(expected[@"mode"],current.st_mode) ||
        !decimalEqual(expected[@"uid"],current.st_uid) || !decimalEqual(expected[@"gid"],current.st_gid)) return fail(@"observation_changed");
    if (isDirectory) {
        PPSDir *node=directory(path); if (!node || node.fd<0) return fail(@"observation_changed");
        if (([path isEqual:rootPath] || beneath(path,rootPath)) && !safeDirectory(node.fd,current,YES)) return NO;
    } else {
        NSDictionary *version=expected[@"fileVersion"];
        if (!keys(version,@[@"sizeBytes",@"nlink",@"mtimeNs",@"ctimeNs"],@[]) || !decimalEqual(version[@"sizeBytes"],current.st_size) ||
            !decimalEqual(version[@"nlink"],current.st_nlink) || !timeEqual(version[@"mtimeNs"],current.st_mtimespec) || !timeEqual(version[@"ctimeNs"],current.st_ctimespec)) return fail(@"observation_changed");
        if (([path isEqual:rootPath] || beneath(path,rootPath)) && current.st_dev != rootNode.identity.st_dev) return fail(@"unsafe_entry");
    }
    return YES;
}
static BOOL verifyObservations(void) { for (NSDictionary *item in observations) if (!observe(item)) return NO; return linkage(); }
static BOOL expectedFile(PPSFile *file, struct stat st) {
    return S_ISREG(st.st_mode) && st.st_nlink == 1 && st.st_dev == rootNode.identity.st_dev &&
        st.st_dev == file.identity.st_dev && st.st_ino == file.identity.st_ino &&
        st.st_uid == getuid() && st.st_gid == file.identity.st_gid &&
        (st.st_mode&07777) == (file.modeFinal?[file.input[@"mode"] unsignedIntValue]:0600);
}
static BOOL fileNamed(PPSFile *file) {
    struct stat linked;
    if (fstatat(file.parent.fd,file.name.fileSystemRepresentation,&linked,AT_SYMLINK_NOFOLLOW) ||
        !expectedFile(file,linked)) return fail(@"observation_changed");
    return YES;
}
static BOOL fileLinked(PPSFile *file, int fd) {
    struct stat opened;
    if (fstat(fd,&opened) || !expectedFile(file,opened)) return fail(@"observation_changed");
    return fileNamed(file);
}
static BOOL verifyBytes(PPSFile *file, int fd) {
    if(!emptyAcl(fd))return NO;
    struct stat before, after; if (fstat(fd,&before) || before.st_size != (off_t)file.bytes.length || (before.st_mode&07777) != [file.input[@"mode"] unsignedIntValue]) return fail(@"verification_failed");
    if (lseek(fd,0,SEEK_SET)<0) return fail(@"io_error");
    CC_SHA256_CTX hash; CC_SHA256_Init(&hash); uint8_t bytes[8192]; size_t readBytes=0;
    while (readBytes < file.bytes.length) {
        if (!checkpoint() || !fileLinked(file,fd)) return NO;
        ssize_t n=read(fd,bytes,MIN(sizeof(bytes),file.bytes.length-readBytes));
        if (n<0 && errno==EINTR) continue; if(n<=0) return fail(@"io_error");
        CC_SHA256_Update(&hash,bytes,(CC_LONG)n); readBytes+=(size_t)n;
    }
    unsigned char digest[32]; CC_SHA256_Final(digest,&hash); char text[65]; for(int i=0;i<32;i++)snprintf(text+i*2,3,"%02x",digest[i]);text[64]=0;
    if (![file.input[@"sha256"] isEqual:[NSString stringWithUTF8String:text]] || fstat(fd,&after) || !sameNode(before,after) ||
        before.st_size!=after.st_size || before.st_mtimespec.tv_sec!=after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec!=after.st_mtimespec.tv_nsec ||
        before.st_ctimespec.tv_sec!=after.st_ctimespec.tv_sec || before.st_ctimespec.tv_nsec!=after.st_ctimespec.tv_nsec) return fail(@"verification_failed");
    return fileLinked(file,fd);
}
static BOOL closeFile(int fd, NSString *destination) {
    BOOL injected=fault(@"close",destination)!=nil; int rc=close(fd); // never retry close: descriptor ownership may already be gone
    return rc || injected ? fail(@"close_failed") : YES;
}
static BOOL verifyNamedBytes(PPSFile *file) {
    int fd=openat(file.parent.fd,file.name.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);
    if(fd<0)return fail(@"observation_changed");
    BOOL ok=verifyBytes(file,fd);
    if(!closeFile(fd,file.destination))ok=NO;
    return ok && fileNamed(file);
}
static BOOL recordIntent(NSString *operation, NSString *destination) {
    return emit(@{@"event":@"mutation_intent",@"operation":operation,@"destination":destination}) && checkpoint();
}
static NSDictionary *identity(struct stat st) { return @{@"dev":[NSString stringWithFormat:@"%llu",(unsigned long long)st.st_dev],@"ino":[NSString stringWithFormat:@"%llu",(unsigned long long)st.st_ino]}; }
static BOOL validateRequest(void) {
    if (!keys(request,@[@"protocol",@"helperVersion",@"fixtureBase",@"root",@"expectedParentPid",@"environment",@"observations",@"directories",@"files"],@[@"controls",@"coordinator"]) ||
        !integer(request[@"protocol"],1) || [request[@"protocol"] intValue]!=1 || ![request[@"helperVersion"] isEqual:VERSION] ||
        !integer(request[@"expectedParentPid"],INT_MAX) || [request[@"expectedParentPid"] intValue]!=expectedParent ||
        !absolute(request[@"root"]) || !absolute(request[@"fixtureBase"]) || !beneath(request[@"root"],request[@"fixtureBase"]) ||
        ![request[@"observations"] isKindOfClass:NSArray.class] || [request[@"observations"] count]>MAX_OBS ||
        ![request[@"directories"] isKindOfClass:NSArray.class] || [request[@"directories"] count]>MAX_DIRS ||
        ![request[@"files"] isKindOfClass:NSArray.class] || [request[@"files"] count]>MAX_FILES) return fail(@"invalid_request");
    if (request[@"controls"] && !PPS_TESTING) return fail(@"test_controls_disabled");
    controls=request[@"controls"];
    if (controls && (!keys(controls,@[@"barriers",@"faults"],@[]) || ![controls[@"barriers"] isKindOfClass:NSArray.class] ||
        ![controls[@"faults"] isKindOfClass:NSArray.class] || [controls[@"barriers"] count]>16 || [controls[@"faults"] count]>16)) return fail(@"invalid_request");
    for (NSDictionary *b in controls[@"barriers"] ?: @[]) if (!keys(b,@[@"point"],@[@"destination"]) || ![@[@"after_preflight",@"before_create",@"after_create_check",@"after_create",@"after_write",@"before_mkdir",@"after_mkdir_check",@"after_mkdir"] containsObject:b[@"point"]] || (b[@"destination"] && !portable(b[@"destination"],YES))) return fail(@"invalid_request");
    for (NSDictionary *f in controls[@"faults"] ?: @[]) if (!keys(f,@[@"point",@"destination"],@[@"afterBytes",@"shortBytes",@"error"]) || ![@[@"write",@"zero_write",@"short_write",@"sync",@"directory_sync",@"chmod",@"close",@"readback"] containsObject:f[@"point"]] || !portable(f[@"destination"],YES) || (f[@"error"] && (![@[@"EIO",@"ENOSPC",@"EACCES"] containsObject:f[@"error"]] || ![f[@"point"] isEqual:@"write"])) || (f[@"afterBytes"] && !integer(f[@"afterBytes"],MAX_SOURCE)) || (f[@"shortBytes"] && (!integer(f[@"shortBytes"],8192) || [f[@"shortBytes"] intValue]<1))) return fail(@"invalid_request");
    NSMutableSet *paths=[NSMutableSet new], *obsPaths=[NSMutableSet new];
    for (NSDictionary *obs in request[@"observations"]) {
        if (!keys(obs,@[@"scope",@"path",@"observation"],@[]) || !absolute(obs[@"path"]) || ![@[@"anchor",@"target",@"git_metadata"] containsObject:obs[@"scope"]] || [obsPaths containsObject:obs[@"path"]]) return fail(@"invalid_request");
        NSDictionary *o=obs[@"observation"];
        if (!keys(o,@[@"state"],@[@"kind",@"dev",@"ino",@"mode",@"uid",@"gid",@"fileVersion",@"reason"]) || ![@[@"present",@"absent",@"unverified"] containsObject:o[@"state"]]) return fail(@"invalid_request");
        [obsPaths addObject:obs[@"path"]];
    }
    for (NSDictionary *d in request[@"directories"]) {
        if (!keys(d,@[@"destination",@"mode"],@[]) || !portable(d[@"destination"],YES) || !integer(d[@"mode"],0755) || [d[@"mode"] intValue]!=0755) return fail(@"invalid_request");
        NSString *fold=[d[@"destination"] precomposedStringWithCanonicalMapping].lowercaseString;
        if ([paths containsObject:fold]) return fail(@"invalid_request"); [paths addObject:fold];
        [ledger addObject:[@{@"destination":d[@"destination"],@"kind":@"directory",@"state":@"not_attempted"} mutableCopy]];
    }
    NSUInteger total=0;
    for (NSDictionary *f in request[@"files"]) {
        if (!keys(f,@[@"destination",@"status",@"mode",@"sizeBytes",@"sha256",@"bytesBase64"],@[]) || !portable(f[@"destination"],YES) || [f[@"destination"] componentsSeparatedByString:@"/"].count<4 ||
            !integer(f[@"mode"],0755) || ![@[@(0644),@(0755)] containsObject:f[@"mode"]] || !integer(f[@"sizeBytes"],MAX_SOURCE) || !stringValue(f[@"bytesBase64"]) ||
            !stringValue(f[@"sha256"]) || ![@[@"create",@"unchanged",@"conflict",@"blocked"] containsObject:f[@"status"]]) return fail(@"invalid_request");
        NSString *fold=[f[@"destination"] precomposedStringWithCanonicalMapping].lowercaseString;
        if ([paths containsObject:fold]) return fail(@"invalid_request"); [paths addObject:fold];
        PPSFile *file=[PPSFile new]; file.input=f; file.destination=f[@"destination"]; file.name=file.destination.lastPathComponent;
        file.bytes=[[NSData alloc] initWithBase64EncodedString:f[@"bytesBase64"] options:0];
        if (!file.bytes || ![[file.bytes base64EncodedStringWithOptions:0] isEqual:f[@"bytesBase64"]] || file.bytes.length!=[f[@"sizeBytes"] unsignedIntegerValue] || ![sha(file.bytes) isEqual:f[@"sha256"]]) return fail(@"source_mismatch");
        total+=file.bytes.length; if(total>MAX_SOURCE) return fail(@"limit_exceeded");
        file.ledger=[@{@"destination":file.destination,@"kind":@"file",@"state":@"not_attempted",@"bytesWritten":@0,@"writeCalls":@0,@"shortWriteResults":@0} mutableCopy]; [files addObject:file]; [ledger addObject:file.ledger];
    }
    for (PPSFile *file in files) for (NSString *path in paths) if ([path hasPrefix:[[file.destination precomposedStringWithCanonicalMapping].lowercaseString stringByAppendingString:@"/"]]) return fail(@"invalid_request");
    return YES;
}
static BOOL environmentGate(void) {
#if !defined(__arm64__)
    return fail(@"unsupported_environment");
#endif
    NSDictionary *env=request[@"environment"];
    if (!keys(env,@[@"paseoVersion",@"sdkVersion"],@[]) || ![env[@"paseoVersion"] isEqual:@"0.17.5"] || ![env[@"sdkVersion"] isEqual:@"0.17.4"]) return fail(@"unsupported_environment");
    NSOperatingSystemVersion os=NSProcessInfo.processInfo.operatingSystemVersion;
    if (os.majorVersion!=27 || os.minorVersion!=2 || os.patchVersion!=1) return fail(@"unsupported_environment");
    rootPath=request[@"root"]; NSString *base=request[@"fixtureBase"]; char canonical[PATH_MAX], temp[PATH_MAX];
    NSString *tempDir=NSTemporaryDirectory(); if(!realpath(tempDir.fileSystemRepresentation,temp)) return fail(@"unsupported_environment");
    BOOL temporary=beneath(base,@"/private/tmp") || beneath(base,[NSString stringWithUTF8String:temp]);
    if (!temporary || ![base.lastPathComponent hasPrefix:@"pps-m43-"] || !realpath(base.fileSystemRepresentation,canonical) || ![base isEqual:[NSString stringWithUTF8String:canonical]]) return fail(@"fixture_scope_required");
    PPSDir *fixture=directory(base); if(!fixture || fixture.fd<0 || fixture.identity.st_uid!=getuid() || (fixture.identity.st_mode&07777)!=0700) return fail(@"fixture_scope_required");
    rootNode=directory(rootPath); if(!rootNode || rootNode.fd<0) return fail(@"invalid_target");
    struct statfs volume; if(fstatfs(rootNode.fd,&volume) || strcmp(volume.f_fstypename,"apfs") || !(volume.f_flags&MNT_LOCAL) || (volume.f_flags&MNT_RDONLY)) return fail(@"unsupported_environment");
    long caseSensitive=fpathconf(rootNode.fd,_PC_CASE_SENSITIVE);
    if(caseSensitive!=0) return fail(@"unsupported_case_mode");
    if (fixture.identity.st_dev != rootNode.identity.st_dev) return fail(@"unsupported_environment");
    if (!safeDirectory(fixture.fd,fixture.identity,YES) || !safeDirectory(rootNode.fd,rootNode.identity,YES)) return NO;
    return emit(@{@"event":@"environment",@"filesystem":@"apfs",@"local":@YES,@"caseMode":@"insensitive",@"macOS":@"27.2.1",@"arch":@"arm64",@"fixtureOnly":@YES,@"pid":@(getpid())});
}
static BOOL lockCoordinator(void) {
    NSDictionary *c=request[@"coordinator"]; if(!c) return YES;
    if(!keys(c,@[@"directory"],@[]) || !absolute(c[@"directory"]) || !beneath(c[@"directory"],request[@"fixtureBase"]) ||
       beneath(c[@"directory"],rootPath) || beneath(rootPath,c[@"directory"]) || [c[@"directory"] isEqual:rootPath]) return fail(@"invalid_coordinator");
    PPSDir *node=directory(c[@"directory"]); if(!node || node.fd<0 || node.identity.st_uid!=getuid() || (node.identity.st_mode&07777)!=0700 || !emptyAcl(node.fd)) return fail(@"invalid_coordinator");
    coordinatorFd=openat(node.fd,"writer.lock",O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
    if(coordinatorFd<0 && errno==EEXIST) coordinatorFd=openat(node.fd,"writer.lock",O_RDWR|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);
    struct stat st,linked;
    if(coordinatorFd<0 || fstat(coordinatorFd,&st) || !S_ISREG(st.st_mode) || st.st_dev!=rootNode.identity.st_dev ||
        st.st_nlink!=1 || st.st_uid!=getuid() || (st.st_mode&07777)!=0600 ||
        fstatat(node.fd,"writer.lock",&linked,AT_SYMLINK_NOFOLLOW) || !sameNode(st,linked)) return fail(@"invalid_coordinator");
    if(!emptyAcl(coordinatorFd))return fail(@"invalid_coordinator");
    if(flock(coordinatorFd,LOCK_EX|LOCK_NB)) return fail(errno==EWOULDBLOCK ? @"busy" : @"coordinator_error");
    coordinatorNode=node;coordinatorIdentity=st;
    return emit(@{@"event":@"lock_acquired",@"pid":@(getpid()),@"identity":identity(st)});
}
static BOOL preflight(void) {
    for(PPSFile *file in files) if(![@[@"create",@"unchanged"] containsObject:file.input[@"status"]]) return fail(@"plan_not_applicable");
    observations=request[@"observations"];
    // Require a root identity and every anchor/parent used for writes in the approved read-set.
    NSMutableDictionary *byPath=[NSMutableDictionary new]; for(NSDictionary *o in observations) byPath[o[@"path"]]=o;
    if(!byPath[rootPath] || ![byPath[rootPath][@"observation"][@"state"] isEqual:@"present"]) return fail(@"invalid_request");
    if(!verifyObservations()) return NO;
    NSUInteger index=0;
    NSMutableSet *effectsSeen=[NSMutableSet new];
    for(NSDictionary *d in request[@"directories"]) {
        NSString *path=[rootPath stringByAppendingPathComponent:d[@"destination"]]; PPSDir *node=directory(path);
        if(!node || node.fd>=0) return fail(@"observation_changed");
        PPSDir *parent=dirs[(NSUInteger)node.parent];
        if(parent.fd<0 && ![effectsSeen containsObject:parent.path])return fail(@"invalid_request");
        [effectsSeen addObject:node.path];
        node.ledger=ledger[index++];
    }
    for(PPSFile *file in files) {
        NSString *full=[rootPath stringByAppendingPathComponent:file.destination]; file.parent=directory(full.stringByDeletingLastPathComponent);
        if(!file.parent) return NO;
        struct stat st; int rc=file.parent.fd<0 ? (errno=ENOENT,-1) : fstatat(file.parent.fd,file.name.fileSystemRepresentation,&st,AT_SYMLINK_NOFOLLOW);
        if([file.input[@"status"] isEqual:@"create"]) { if(!rc || errno!=ENOENT) return fail(@"destination_exists"); }
        else {
            if(rc || !S_ISREG(st.st_mode) || st.st_nlink!=1 || st.st_uid!=getuid() || st.st_dev!=rootNode.identity.st_dev || !byPath[full]) return fail(@"observation_changed");
            file.identity=st; file.modeFinal=YES; int fd=openat(file.parent.fd,file.name.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);
            if(fd<0) return fail(@"io_error"); BOOL ok=verifyBytes(file,fd); if(!closeFile(fd,file.destination))ok=NO; if(!ok)return NO;
            file.ledger[@"state"]=@"unchanged_verified";
        }
    }
    // Every directory is either an exact observed existing node, or an explicit
    // missing effect beneath a first-missing observed name. Never infer new effects.
    for(PPSDir *node in dirs) {
        if([node.path isEqual:rootPath] || beneath(node.path,rootPath)) {
            if(node.fd>=0) { if(!byPath[node.path] || !safeDirectory(node.fd,node.identity,YES)) return fail(@"invalid_request"); }
            else if(!node.ledger) return fail(@"missing_directory_effect");
        }
        if(node.fd<0) {
            BOOL proved=NO; NSString *path=node.path;
            while(beneath(path,rootPath)) { if([byPath[path][@"observation"][@"state"] isEqual:@"absent"]){proved=YES;break;}path=path.stringByDeletingLastPathComponent; }
            if(!proved)return fail(@"invalid_request");
        }
    }
    struct rlimit limit; if(getrlimit(RLIMIT_NOFILE,&limit) || dirs.count + 16 >= limit.rlim_cur) return fail(@"limit_exceeded");
    return linkage() && barrier(@"after_preflight",nil);
}
static BOOL createDirectories(void) {
    for(NSDictionary *effect in request[@"directories"]) {
        PPSDir *node=dirByPath[[rootPath stringByAppendingPathComponent:effect[@"destination"]]];
        PPSDir *parent=dirs[(NSUInteger)node.parent]; NSString *destination=effect[@"destination"];
        if(parent.fd<0) return fail(@"invalid_request");
        if(!barrier(@"before_mkdir",destination) || !linkage() || !barrier(@"after_mkdir_check",destination) || !recordIntent(@"mkdirat",destination)) return NO;
        if(mkdirat(parent.fd,node.name.fileSystemRepresentation,0755)) {
            if(errno==EIO){uncertain=YES;node.ledger[@"state"]=@"ownership_unknown";}
            return fail(errno==EEXIST ? @"destination_exists" : @"mkdir_failed");
        }
        mutated=YES; node.created=YES; node.ledger[@"state"]=@"created_incomplete";
        struct stat namedIdentity, createdIdentity;
        if(fstatat(parent.fd,node.name.fileSystemRepresentation,&namedIdentity,AT_SYMLINK_NOFOLLOW) || !S_ISDIR(namedIdentity.st_mode) ||
           (namedIdentity.st_mode&07777)!=0755 || namedIdentity.st_uid!=getuid()) { uncertain=YES;node.ledger[@"state"]=@"ownership_unknown";return fail(@"ownership_unknown"); }
        if(!barrier(@"after_mkdir",destination))return NO;
        node.fd=openat(parent.fd,node.name.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
        if(node.fd<0 || fstat(node.fd,&createdIdentity) || !sameNode(namedIdentity,createdIdentity)) { uncertain=YES;node.ledger[@"state"]=@"ownership_unknown";return fail(@"ownership_unknown"); }
        // mkdirat has no returned handle. Initial identity capture has a small
        // cooperative-namespace window; never chmod an unproven new directory.
        node.identity=createdIdentity;
        node.ledger[@"identity"]=identity(node.identity);
        if(!linkage() || !safeDirectory(node.fd,node.identity,YES)) return NO;
        if(fsync(node.fd) || fsync(parent.fd) || fault(@"directory_sync",destination)) return fail(@"sync_failed");
        if(!linkage())return NO; node.ledger[@"state"]=@"created_verified";
    }
    return YES;
}
static BOOL createFiles(void) {
    NSMutableSet<NSString *> *verifiedDerivedSkills=[NSMutableSet new];
    for(PPSFile *file in files) {
        if([file.input[@"status"] isEqual:@"unchanged"]) continue;
        NSString *destination=file.destination;
        if(!barrier(@"before_create",destination) || !linkage())return NO;
        if([destination hasPrefix:@".kiro/"]) {
            NSString *skill=[destination componentsSeparatedByString:@"/"][2];
            if(![verifiedDerivedSkills containsObject:skill]) {
                NSString *prefix=[NSString stringWithFormat:@".agents/skills/%@/",skill];
                for(PPSFile *dependency in files) {
                    if(![dependency.destination hasPrefix:prefix])continue;
                    if(!verifyNamedBytes(dependency)) {
                        dependency.ledger[@"state"]=@"observation_changed";
                        return NO;
                    }
                }
                [verifiedDerivedSkills addObject:skill];
            }
        }
        if(!linkage() || !barrier(@"after_create_check",destination) || !recordIntent(@"openat_exclusive",destination))return NO;
        int fd=openat(file.parent.fd,file.name.fileSystemRepresentation,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
        if(fd<0){if(errno==EIO){uncertain=YES;file.ledger[@"state"]=@"ownership_unknown";}return fail(errno==EEXIST ? @"destination_exists" : @"create_failed");}
        mutated=YES; file.ledger[@"state"]=@"created_incomplete";
        struct stat createdIdentity={0}; BOOL ok=fstat(fd,&createdIdentity)==0; file.identity=createdIdentity;
        if(!ok){uncertain=YES;fail(@"ownership_unknown");}
        else {file.ledger[@"identity"]=identity(file.identity);ok=barrier(@"after_create",destination)&&linkage()&&fileLinked(file,fd);}
        const uint8_t *bytes=file.bytes.bytes; NSUInteger offset=0;
        while(ok && offset<file.bytes.length) {
            if(!checkpoint()||!linkage()||!fileLinked(file,fd)){ok=NO;break;}
            NSDictionary *ioFault=fault(@"write",destination), *shortFault=fault(@"short_write",destination);
            if(ioFault && offset >= [ioFault[@"afterBytes"] unsignedIntegerValue]) {errno=[ioFault[@"error"] isEqual:@"ENOSPC"]?ENOSPC:[ioFault[@"error"] isEqual:@"EACCES"]?EACCES:EIO;file.ledger[@"systemErrno"]=@(errno);ok=fail(@"write_failed");break;}
            size_t count=MIN((NSUInteger)8192,file.bytes.length-offset);
            if(ioFault)count=MIN(count,[ioFault[@"afterBytes"] unsignedIntegerValue]-offset);
            size_t actualRequest=shortFault ? MIN(count,MAX((NSUInteger)1,[shortFault[@"shortBytes"] unsignedIntegerValue])) : count;
            // The test seam performs a real smaller write and returns that short
            // positive result to the normal full-count caller below.
            ssize_t written=fault(@"zero_write",destination)?0:write(fd,bytes+offset,actualRequest);
            file.ledger[@"writeCalls"]=@([file.ledger[@"writeCalls"] unsignedIntegerValue]+1);
            if(written>0 && (size_t)written<count)file.ledger[@"shortWriteResults"]=@([file.ledger[@"shortWriteResults"] unsignedIntegerValue]+1);
            if(written<0&&errno==EINTR)continue;
            if(written<=0){file.ledger[@"systemErrno"]=@(written==0?EIO:errno);ok=fail(@"write_failed");break;}offset+=(NSUInteger)written;file.ledger[@"bytesWritten"]=@(offset);
        }
        if(ok)ok=barrier(@"after_write",destination)&&linkage()&&fileLinked(file,fd);
        if(ok && (fault(@"chmod",destination)||fchmod(fd,[file.input[@"mode"] unsignedIntValue])))ok=fail(@"chmod_failed");
        if(ok)file.modeFinal=YES;
        if(ok && (fault(@"sync",destination)||fsync(fd)))ok=fail(@"sync_failed");
        if(ok && fault(@"readback",destination))ok=fail(@"verification_failed");
        if(ok)ok=verifyBytes(file,fd)&&linkage();
        if(!closeFile(fd,destination))ok=NO;
        if(ok && (fault(@"directory_sync",destination)||fsync(file.parent.fd)))ok=fail(@"sync_failed");
        if(ok)ok=linkage()&&fileNamed(file);
        if(!ok)return NO;
        file.ledger[@"state"]=@"created_verified";
        if(!emit(@{@"event":@"file_verified",@"destination":destination,@"identity":identity(file.identity)}))return NO;
    }
    // Reopen only for read after close, then bind to the owned/unchanged identity.
    for(PPSFile *file in files) {
        if(!verifyNamedBytes(file)){file.ledger[@"state"]=@"observation_changed";return NO;}
    }
    for(NSDictionary *item in observations) {
        NSString *path=item[@"path"];PPSDir *node=dirByPath[path];
        BOOL ownFile=NO;for(PPSFile *file in files)if([path isEqual:[rootPath stringByAppendingPathComponent:file.destination]] && [file.input[@"status"] isEqual:@"create"]){ownFile=YES;break;}
        if((node && node.created)||ownFile)continue;
        if(!observe(item))return NO;
    }
    return linkage();
}
static void closeTargets(void) {
    for(PPSDir *node in dirs) if(node.fd>=0 && !(coordinatorNode && ([node.path isEqual:@"/"] || [node.path isEqual:coordinatorNode.path] || beneath(coordinatorNode.path,node.path)))) { if(close(node.fd))fail(@"close_failed");node.fd=-1; }
}
static void releaseCoordinator(void) {
    if(coordinatorFd>=0){if(close(coordinatorFd))fail(@"close_failed");coordinatorFd=-1;}
    for(PPSDir *node in dirs)if(node.fd>=0){if(close(node.fd))fail(@"close_failed");node.fd=-1;}
}
static NSDictionary *resultValue(void) {
    NSString *phase=errorCode ? (uncertain?@"uncertain":mutated?@"partial_failure":@"failed_before_write") : @"completed";
    return @{@"event":@"result",@"protocol":@1,@"version":VERSION,@"phase":phase,@"code":errorCode?:@"none",@"targetMutated":uncertain&&!mutated?@"unknown":@(mutated),@"ledger":ledger,@"checkpoints":@(syscallCount),@"durability":errorCode?@"not_confirmed":@"fsync_completed"};
}
int main(int argc,char **argv) { @autoreleasepool {
    signal(SIGPIPE,SIG_IGN); expectedParent=getppid(); deadline=monotonic()+30;
    umask(0); // Isolated single-operation helper only; never changes the daemon/Node umask.
    if(argc==2&&!strcmp(argv[1],"--version")) {
        emit(@{@"protocol":@1,@"version":VERSION,@"fixtureOnly":@YES,@"testing":@(PPS_TESTING),@"arch":@"arm64"});return 0;
    }
    if(argc!=2||strcmp(argv[1],"--worker"))return 2;
    dirs=[NSMutableArray new];dirByPath=[NSMutableDictionary new];files=[NSMutableArray new];ledger=[NSMutableArray new];inputBuffer=[NSMutableData new];usedBarriers=[NSMutableSet new];
    NSData *line=readLine(); if(line && line.length<=MAX_WIRE) request=[NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
    BOOL ok=request && validateRequest() && environmentGate() && lockCoordinator() && preflight() && createDirectories() && createFiles();
    if(!ok && !errorCode)errorCode=@"invalid_request";
    closeTargets();
    if(coordinatorNode && !parentGone) {
        // M4.4 may persist its journal while this same helper still owns flock.
        // No target mutation follows this event. A vanished parent releases at exit.
        if(coordinatorLinked() && emit(@{@"event":@"ready_to_finalize",@"result":resultValue(),@"lockHeld":@YES})) {
            NSData *ack=readLine();
            if(!ack || ![[[NSString alloc] initWithData:ack encoding:NSUTF8StringEncoding] isEqual:@"FINALIZE"])fail(@"finalization_failed");
            (void)coordinatorLinked();
        }
    }
    releaseCoordinator();
    emit(resultValue());
    return errorCode?1:0;
}}
