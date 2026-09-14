import { createServer, type Server } from "http";
import { once } from "events";
import { Agent, fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicOnlyLookup, hostIsPublic, fetchPublicBuffer } from "../lib/store";

// Regression cover for the connect-time SSRF pin. The guard's lookup is a
// dns.lookup replacement, so it must answer with the SAME ARITY net asks for.
// net.connect passes { all: true } whenever autoSelectFamily is on (the
// default since Node 20) and then requires an array of { address, family }.
// A single-value answer makes net build "undefined" as the address and every
// request fails with ERR_INVALID_IP_ADDRESS — the guard ends up blocking all
// traffic instead of only internal addresses, which is how the whole remote
// media path (video downloads) silently died while the guard's own unit tests
// kept passing.
describe("SSRF connect-time lookup contract", () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("payload");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    await once(server, "close");
  });

  it("answers with an address array when the caller asks for all", async () => {
    const lookup = createPublicOnlyLookup(() => false);
    const result = await new Promise<unknown>((resolve, reject) => {
      lookup("localhost", { all: true }, (err, address) => (err ? reject(err) : resolve(address)));
    });
    expect(Array.isArray(result)).toBe(true);
    expect((result as Array<unknown>)[0]).toMatchObject({
      address: expect.any(String),
      family: expect.any(Number),
    });
  });

  it("answers with a single address when the caller does not ask for all", async () => {
    const lookup = createPublicOnlyLookup(() => false);
    const result = await new Promise<unknown>((resolve, reject) => {
      lookup("localhost", {}, (err, address) => (err ? reject(err) : resolve(address)));
    });
    expect(typeof result).toBe("string");
  });

  it("fails closed with EACCES when every resolved address is blocked", async () => {
    const lookup = createPublicOnlyLookup(() => true);
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      lookup("localhost", { all: true }, (e) => resolve(e as NodeJS.ErrnoException));
    });
    expect(err?.code).toBe("EACCES");
  });

  // The real thing: a socket must actually be established through the lookup.
  // The filter is permissive here (loopback is the only address a test can
  // reach), so what is under test is the callback shape, not the blocklist.
  it("establishes a connection through the pinned lookup", async () => {
    const agent = new Agent({ connect: { lookup: createPublicOnlyLookup(() => false) } });
    try {
      const res = await undiciFetch(`http://localhost:${port}/`, { dispatcher: agent });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("payload");
    } finally {
      await agent.close();
    }
  });

  it("still refuses a genuinely private address through the same path", async () => {
    const agent = new Agent({ connect: { lookup: createPublicOnlyLookup() } });
    try {
      await expect(undiciFetch(`http://localhost:${port}/`, { dispatcher: agent })).rejects.toThrow();
    } finally {
      await agent.close();
    }
  });
});

describe("hostIsPublic IPv6 blocklist", () => {
  it("refuses multicast, site-local, documentation and Teredo ranges", async () => {
    for (const host of [
      "[ff02::1]", // multicast
      "[fec0::1]", // deprecated site-local
      "[2001:db8::1]", // documentation
      "[2001:0:1::1]", // Teredo
      "[100::1]", // discard-only
    ]) {
      expect(await hostIsPublic(host)).toBe(false);
    }
  });

  it("still allows a routable global unicast address", async () => {
    expect(await hostIsPublic("[2606:4700:4700::1111]")).toBe(true);
  });
});

describe("fetchPublicBuffer", () => {
  it("rejects an internally-addressed URL before connecting", async () => {
    await expect(
      fetchPublicBuffer("http://127.0.0.1:80/x", { timeoutMs: 500, maxBytes: 10 }),
    ).rejects.toThrow("blocked-internal-url");
  });
});
