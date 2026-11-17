import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { noteDocRev, readDocRev, takeExpectedRev } from "@/lib/doc-rev";

const COOKIE = "portal_sess=abc123";

/** Only the cookie header is set, as a browser sends under an HttpOnly session. */
function cookieRequest(rev?: string) {
	return {
		headers: {
			get: (k: string) => {
				const key = k.toLowerCase();
				if (key === "cookie") return COOKIE;
				if (key === "x-dockit-rev") return rev ?? null;
				return null;
			}
		}
	};
}

function bareRequest(rev?: string) {
	return {
		headers: {
			get: (k: string) => (k.toLowerCase() === "x-dockit-rev" ? (rev ?? null) : null)
		}
	};
}

describe("takeExpectedRev with an HttpOnly session", () => {
	it("honours the header rev when the cookie is the only credential", () => {
		expect(takeExpectedRev({ token: "" }, cookieRequest("7"))).toBe(7);
	});

	it("still prefers an explicit body rev", () => {
		expect(takeExpectedRev({ token: "", rev: 3 }, cookieRequest("7"))).toBe(3);
	});

	it("ignores a request with neither cookie nor token", () => {
		expect(takeExpectedRev({ token: "" }, bareRequest("7"))).toBeUndefined();
		expect(takeExpectedRev({ rev: 4 }, bareRequest("9"))).toBeUndefined();
	});

	it("ignores a cookie that is not a session cookie", () => {
		const other = { headers: { get: (k: string) => (k.toLowerCase() === "cookie" ? "theme=dark" : "7") } };
		expect(takeExpectedRev({ token: "" }, other)).toBeUndefined();
	});
});

describe("a client that has not loaded a document", () => {
	it("reports no revision, so sign-in cannot assert rev 0", async () => {
		vi.resetModules();
		const fresh = await import("@/lib/doc-rev");
		expect(fresh.readDocRev()).toBeNull();
		fresh.noteDocRev({ rev: 5 });
		expect(fresh.readDocRev()).toBe(5);
	});

	it("records a real rev of 0 distinctly from having seen nothing", () => {
		noteDocRev({ rev: 0 });
		expect(readDocRev()).toBe(0);
	});
});

describe("mutate under a cookie session", () => {
	let dataFile = "";
	let store: typeof import("@/lib/portal/store");

	beforeAll(async () => {
		dataFile = join(mkdtempSync(join(tmpdir(), "dockit-rev-")), "portal.json");
		writeFileSync(dataFile, JSON.stringify({
			settings: { title: "Dockit" },
			spaces: [{ id: "s1", name: "Home", categories: [] }],
			users: [],
			rev: 4
		}));
		process.env.PORTAL_DATA_FILE = dataFile;
		store = await import("@/lib/portal/store");
	});

	afterAll(() => {
		delete process.env.PORTAL_DATA_FILE;
	});

	function revOnDisk() {
		return JSON.parse(readFileSync(dataFile, "utf8")).rev;
	}

	it("bumps the revision when the cookie client sends a matching one", async () => {
		await store.mutate({ token: "", rev: 4 }, cookieRequest(), (doc: any) => {
			doc.settings.title = "Renamed";
		}, { allowWeakAdmin: true });
		expect(revOnDisk()).toBe(5);
	});

	it("rejects a stale write instead of silently overwriting", async () => {
		await expect(store.mutate({ token: "", rev: 1 }, cookieRequest(), (doc: any) => {
			doc.settings.title = "Stale";
		}, { allowWeakAdmin: true })).rejects.toThrow("errors.conflict");
		expect(revOnDisk()).toBe(5);
	});
});
