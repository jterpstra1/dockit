import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Server fns resolve their context from the Start runtime, so the wrapper is
 * stubbed down to validator + handler. The validator must still run: the bug
 * this covers is the payload being rejected before the handler ever sees it.
 */
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let schema: { parse?: (v: unknown) => unknown } | null = null;
		const api: any = {
			middleware: () => api,
			validator: (s: any) => {
				schema = s;
				return api;
			},
			handler: (fn: any) => (ctx: any) => {
				const data = typeof schema?.parse === "function" ? schema.parse(ctx.data) : ctx.data;
				return fn({ ...ctx, data, request: ctx.request });
			}
		};
		return api;
	},
	createMiddleware: () => {
		const api: any = { client: () => api, server: () => api };
		return api;
	}
}));

const CARD_ID = "card-1";
const CAT_ID = "cat-1";

let dataFile = "";

function cardOnDisk() {
	const doc = JSON.parse(readFileSync(dataFile, "utf8"));
	return doc.spaces
		.flatMap((s: any) => s.categories)
		.flatMap((c: any) => c.cards)
		.find((c: any) => c.id === CARD_ID);
}

function seedStore() {
	const file = join(mkdtempSync(join(tmpdir(), "dockit-cookie-")), "portal.json");
	writeFileSync(file, JSON.stringify({
		settings: { title: "Dockit" },
		// "owner" is reserved for id "admin"; asStore downgrades it. Editor grants space edit.
		users: [{ id: "u1", username: "jurre", source: "local", roleIds: ["editeur"], role: "editeur" }],
		spaces: [{
			id: "s1",
			name: "Home",
			categories: [{
				id: CAT_ID,
				name: "Applications",
				cards: [{ id: CARD_ID, kind: "app", title: "Before", description: "", url: "https://a.example", icon: "Link" }]
			}]
		}]
	}));
	return file;
}

/** A request carrying only the session cookie — what the browser sends under HttpOnly. */
function cookieRequest(token: string) {
	return {
		url: "https://dock.example/",
		headers: {
			get: (k: string) => (k.toLowerCase() === "cookie" ? `portal_sess=${token}` : null)
		}
	};
}

const payload = {
	categoryId: CAT_ID,
	kind: "app" as const,
	title: "After",
	description: "",
	url: "https://a.example",
	icon: "Link",
	tags: [] as string[]
};

let mod: typeof import("@/lib/portal/fns-catalog");
let session: typeof import("@/lib/portal/session");

beforeAll(async () => {
	dataFile = seedStore();
	process.env.PORTAL_DATA_FILE = dataFile;
	mod = await import("@/lib/portal/fns-catalog");
	session = await import("@/lib/portal/session");
});

afterAll(() => {
	delete process.env.PORTAL_DATA_FILE;
});

describe("tokenField", () => {
	it("accepts a request that carries no payload token", () => {
		const schema = z.object({ token: session.tokenField, id: z.string().min(1) });
		expect(() => schema.parse({ token: "", id: CARD_ID })).not.toThrow();
		expect(() => schema.parse({ id: CARD_ID })).not.toThrow();
	});

	it("still accepts a real token, for clients that hold one", () => {
		const schema = z.object({ token: session.tokenField });
		expect(() => schema.parse({ token: "a".repeat(48) })).not.toThrow();
	});
});

describe("tok", () => {
	it("prefers the cookie over the payload", () => {
		expect(session.tok({ token: "" }, cookieRequest("cookie-token"))).toBe("cookie-token");
	});

	it("resolves to nothing when neither is present, so auth still fails closed", () => {
		expect(session.tok({ token: "" }, { headers: { get: () => null } })).toBe("");
	});
});

describe("updateCard authenticated by cookie alone", () => {
	it("saves the card when the payload carries no token", async () => {
		const token = session.issueToken("u1");
		expect(cardOnDisk()?.title).toBe("Before");
		await (mod.updateCard as any)({
			data: { token: "", id: CARD_ID, ...payload },
			request: cookieRequest(token)
		});
		expect(cardOnDisk()?.title).toBe("After");
		session.sessions.delete(token);
	});

	it("refuses when there is no cookie and no token", async () => {
		await expect((mod.updateCard as any)({
			data: { token: "", id: CARD_ID, ...payload },
			request: { url: "https://dock.example/", headers: { get: () => null } }
		})).rejects.toThrow();
	});
});
