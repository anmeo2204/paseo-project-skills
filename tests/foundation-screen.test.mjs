import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import renderer from "react-test-renderer";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { PaseoApiProvider, PluginRpcProvider } from "@getpaseo/plugin/client/host";
import contribute from "../index.client.tsx";
import { HostFixture } from "./client-fixture.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler(queueMicrotask);

const theme = { colors: {} };
const layout = { platform: "web", compact: false };
const pathA = "/target-a";
const pathB = "/target-b";

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness(t) {
  const requests = { validation: [], providers: [], projects: [] };
  const saves = [];
  const clients = [];
  let root;
  let screen;
  let sidebar;
  const cleanup = contribute({
    addScreen: (value) => { screen = value; return () => { screen = undefined; }; },
    addSidebarHeaderItem: (value) => { sidebar = value; return () => { sidebar = undefined; }; },
  });
  assert.equal(sidebar.id, screen.id);
  assert.equal(sidebar.title, "Project Skills");

  t.after(async () => {
    await unmount();
    cleanup();
    assert.equal(sidebar, undefined);
    assert.equal(screen, undefined);
    clients.forEach((client) => client.clear());
  });

  const newQueryClient = () => {
    const client = new QueryClient();
    clients.push(client);
    return client;
  };
  let queryClient = newQueryClient();

  function request(queue, details) {
    const response = deferred();
    queue.push({ ...details, ...response });
    return response.promise;
  }

  async function show(id = "host-a", status = "online", ref = "") {
    const host = { id, label: id };
    const hostFixture = {
      hosts: [{ serverId: id, label: id, status }],
      settings: {
        status: "ready", revision: "same-revision", values: { catalogRef: ref },
        save(values, revision) { saves.push({ id, values, revision }); return Promise.resolve(true); },
      },
    };
    const paseo = {
      projects: { list: () => request(requests.projects, { id }) },
      workspaces: { list: async () => ({ entries: [], pageInfo: {} }) },
      providers: { snapshot: ({ cwd }) => request(requests.providers, { id, cwd }) },
    };
    const invoke = (name, input) => {
      assert.equal(name, "target.validate-directory");
      return request(requests.validation, { id, path: input.path });
    };
    const view = createElement(QueryClientProvider, { client: queryClient },
      createElement(HostFixture.Provider, { value: hostFixture },
        createElement(PaseoApiProvider, { paseo },
          createElement(PluginRpcProvider, { invoke },
            createElement(screen.Component, { theme, host, layout, params: {} })))));
    await act(async () => {
      if (root) root.update(view);
      else root = renderer.create(view);
    });
  }

  async function unmount() {
    if (!root) return;
    await act(async () => root.unmount());
    root = undefined;
  }

  function input(label) {
    return root.root.findByType("scroll-view").findAllByType("input")
      .find((item) => item.props.accessibilityLabel === label);
  }

  function press(label) {
    const matches = root.root.findAllByType("pressable").filter((item) => item.findAllByType("text")
      .some((text) => text.children.includes(label)));
    assert.equal(matches.length, 1, label);
    return act(async () => matches[0].props.onPress());
  }

  async function target(path) {
    await act(async () => input("Absolute path on the host").props.onChangeText(path));
    await press("Use directory");
    assert.equal(requests.validation.at(-1).path, path);
    return requests.validation.at(-1);
  }

  return {
    show, unmount, requests, target, input, press, saves,
    replaceQueryClient() { queryClient = newQueryClient(); },
    discoveryPollInterval() {
      const query = queryClient.getQueryCache().find({ queryKey: ["providers", "host-a"], exact: false });
      return query.options.refetchInterval(query);
    },
    rendered() { return JSON.stringify(root.toJSON()); },
    providers() {
      return root.root.findAllByType("pressable").filter((item) => item.props.accessibilityRole === "checkbox");
    },
  };
}

const providerReady = (provider) => ({ provider, enabled: true, status: "ready" });
const ready = {
  entries: [providerReady("codex"), providerReady("cursor"), providerReady("kiro"), providerReady("antigravity")],
};

async function resolve(request, value) {
  await act(async () => request.resolve(value));
}

async function validate(h, input, directory = input) {
  await resolve(await h.target(input), { status: "ready", directory });
  assert.equal(h.requests.providers.at(-1).cwd, directory);
  return h.requests.providers.at(-1);
}

test("real screen renders provider states and allows several ready selections", async (t) => {
  const h = harness(t);
  await h.show();
  const discovery = await validate(h, pathA, "/canonical-a");
  assert.ok(h.providers().every(({ props }) => props.disabled && props.accessibilityLabel.endsWith("loading")));
  await resolve(discovery, { entries: [
    providerReady("codex"), providerReady("cursor"),
    { provider: "kiro", enabled: true, status: "unavailable" },
    { provider: "antigravity", enabled: true, status: "error" },
  ] });
  const [codex, cursor, kiro, antigravity] = h.providers();
  assert.equal(codex.props.accessibilityState.checked, false);
  assert.equal(cursor.props.accessibilityState.checked, false);
  assert.equal(kiro.props.accessibilityLabel, "Kiro, unavailable");
  assert.equal(antigravity.props.accessibilityLabel, "Antigravity, error");
  assert.equal(kiro.props.disabled, true);
  assert.equal(antigravity.props.disabled, true);
  await act(async () => codex.props.onPress());
  await act(async () => cursor.props.onPress());
  assert.equal(h.providers().filter(({ props }) => props.accessibilityState.checked).length, 2);
  await resolve(await validate(h, pathB), ready);
  assert.ok(h.providers().every(({ props }) => !props.accessibilityState.checked));
});

test("late provider results for target A cannot replace B", async (t) => {
  const h = harness(t);
  await h.show();
  const a = await validate(h, pathA);
  const b = await validate(h, pathB);
  await resolve(b, ready);
  await resolve(a, { entries: [] });
  assert.match(h.rendered(), /Target directory: .*\/target-b/);
  assert.ok(h.providers().every(({ props }) => !props.disabled));
});

test("late directory validation cannot change the active target or trigger discovery", async (t) => {
  const h = harness(t);
  await h.show();
  const a = await h.target(pathA);
  const b = await h.target(pathB);
  await resolve(b, { status: "ready", directory: "/canonical-b" });
  await resolve(a, { status: "ready", directory: "/stale-a" });
  assert.deepEqual(h.requests.providers.map(({ cwd }) => cwd), ["/canonical-b"]);
  assert.doesNotMatch(h.rendered(), /stale-a/);
});

test("host switch isolates in-flight requests, visible ref, draft and save destination", async (t) => {
  const h = harness(t);
  await h.show("host-a", "online", "v1-a");
  await act(async () => h.input("Catalog revision").props.onChangeText("draft-a"));
  const a = await validate(h, pathA);
  await h.show("host-b", "online", "v1-b");
  assert.equal(h.input("Catalog revision").props.value, "v1-b");
  assert.match(h.rendered(), /No target directory selected/);
  const b = await validate(h, pathA);
  assert.equal(b.id, "host-b");
  await resolve(b, ready);
  await resolve(a, { entries: [] });
  assert.ok(h.providers().every(({ props }) => !props.disabled));
  await act(async () => h.input("Catalog revision").props.onChangeText("v2-b"));
  await h.press("Save revision");
  assert.deepEqual(h.saves, [{ id: "host-b", values: { catalogRef: "v2-b" }, revision: "same-revision" }]);
  await h.show("host-a", "online", "v1-a");
  assert.equal(h.input("Catalog revision").props.value, "v1-a");
});

test("offline then reconnect discards old validation for the same host and path", async (t) => {
  const h = harness(t);
  await h.show();
  const old = await h.target(pathA);
  await h.show("host-a", "offline");
  assert.match(h.rendered(), /offline/);
  assert.equal(h.input("Catalog revision"), undefined);
  await h.show();
  const current = await h.target(pathA);
  assert.notEqual(current, old);
  await resolve(current, { status: "ready", directory: "/new" });
  await resolve(old, { status: "ready", directory: "/old" });
  assert.deepEqual(h.requests.providers.map(({ cwd }) => cwd), ["/new"]);
});

test("unmount and replacement installation ignore outstanding discovery", async (t) => {
  const h = harness(t);
  await h.show();
  const old = await validate(h, pathA);
  await h.unmount();
  h.replaceQueryClient();
  await h.show();
  const current = await validate(h, pathA);
  await resolve(current, ready);
  await resolve(old, { entries: [] });
  assert.ok(h.providers().every(({ props }) => !props.disabled));
});

test("provider transport failure surfaces an error and retry can recover", async (t) => {
  const h = harness(t);
  await h.show();
  const request = await validate(h, pathA);
  await act(async () => request.reject(new Error("offline")));
  assert.match(h.rendered(), /Could not discover providers/);
  assert.ok(h.providers().every(({ props }) => props.disabled && props.accessibilityLabel.endsWith("error")));
  await h.press("Retry discovery");
  await resolve(h.requests.providers.at(-1), ready);
  assert.ok(h.providers().every(({ props }) => !props.disabled));
});

test("reopening the picker after reconnect does not display the previous project list", async (t) => {
  const h = harness(t);
  await h.show();
  await h.press("Choose project or workspace");
  const old = h.requests.projects.at(-1);
  await resolve(old, { projects: [{
    projectId: "old", projectDisplayName: "Old project", projectKind: "git", projectRootPath: "/old",
  }] });
  assert.match(h.rendered(), /Old project/);
  await h.show("host-a", "offline");
  await h.show();
  await h.press("Choose project or workspace");
  assert.doesNotMatch(h.rendered(), /Old project/);
  await resolve(h.requests.projects.at(-1), { projects: [{
    projectId: "new", projectDisplayName: "New project", projectKind: "git", projectRootPath: "/new",
  }] });
  await h.press("New project");
  assert.equal(h.requests.validation.at(-1).path, "/new");
});

test("discovery polls only while an enabled supported provider is loading", async (t) => {
  const h = harness(t);
  await h.show();
  await resolve(await validate(h, pathA), { entries: [
    { provider: "codex", enabled: true, status: "loading" },
  ] });
  assert.equal(h.discoveryPollInterval(), 1500);
  await resolve(await validate(h, pathB), { entries: [
    { provider: "codex", enabled: false, status: "loading" },
    { provider: "other", enabled: true, status: "loading" },
  ] });
  assert.equal(h.discoveryPollInterval(), false);
  assert.ok(h.providers().every(({ props }) => props.disabled));
});
