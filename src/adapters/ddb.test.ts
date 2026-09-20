import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchDdbCharacter, parseCharacterId } from "./ddb.ts";

test("parses a bare character id", () => {
  const r = parseCharacterId("167935384");
  assert.ok(r.ok);
  assert.equal(r.value, 167935384);
});

test("parses ids out of the URL forms D&D Beyond uses", () => {
  const urls = [
    "https://www.dndbeyond.com/characters/167935384",
    "http://dndbeyond.com/characters/167935384",
    "https://www.dndbeyond.com/characters/167935384/edit",
    "https://www.dndbeyond.com/profile/Kulran/characters/167935384",
    "  https://www.dndbeyond.com/characters/167935384  ",
  ];
  for (const url of urls) {
    const r = parseCharacterId(url);
    assert.ok(r.ok, `failed on ${url}`);
    assert.equal(r.value, 167935384, url);
  }
});

test("rejects input with no id, without throwing", () => {
  for (const bad of ["", "   ", "not a url", "https://www.dndbeyond.com/campaigns/12345", "0"]) {
    assert.equal(parseCharacterId(bad).ok, false, `expected "${bad}" to be rejected`);
  }
});

const stubFetch = (status: number, body: string) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

test("returns the decoded payload on success", async () => {
  const r = await fetchDdbCharacter(1, { fetch: stubFetch(200, '{"success":true,"data":{"name":"X"}}') });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { success: true, data: { name: "X" } });
});

test("explains that a private sheet must be made public", async () => {
  for (const status of [403, 404]) {
    const r = await fetchDdbCharacter(1, { fetch: stubFetch(status, "") });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /privacy set to Public/);
  }
});

test("reports other HTTP failures with the status", async () => {
  const r = await fetchDdbCharacter(1, { fetch: stubFetch(500, "") });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /HTTP 500/);
});

test("reports a non-JSON response rather than throwing", async () => {
  const r = await fetchDdbCharacter(1, { fetch: stubFetch(200, "<html>maintenance</html>") });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not JSON/);
});

test("reports a transport failure as an error value", async () => {
  const r = await fetchDdbCharacter(1, {
    fetch: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /could not reach D&D Beyond/);
});
