import { createMiddleware } from "@tanstack/react-start";
import { parseSessCookie } from "./session-cookie";

const REV_HEADER = "x-dockit-rev";

// null until this client has actually seen a document. 0 is a real revision,
// so the two cannot share a value: asserting 0 from a client that never loaded
// anything conflicts with every non-empty portal.
let seen: number | null = null;

export function asDocRev(raw: unknown): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.floor(n);
}

export function readDocRev(): number | null {
	return seen;
}

export function noteDocRev(payload: unknown) {
	if (!payload || typeof payload !== "object" || !("rev" in payload)) return;
	seen = asDocRev((payload as { rev: unknown }).rev);
}

export function isConflict(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err || "");
	if (msg !== "errors.conflict") return false;
	try {
		window.dispatchEvent(new Event("portal-doc-conflict"));
	} catch {
		// ignore
	}
	return true;
}

/**
 * Is this request from a signed-in client, rather than a login payload?
 *
 * A payload token used to be the only answer. HttpOnly sessions leave the
 * client with no token to send, so the cookie counts too — otherwise every
 * remote deployment skips the conflict check entirely.
 */
function signedIn(
	data: { token?: unknown } | null | undefined,
	request?: { headers?: { get?: (k: string) => string | null } } | null,
): boolean {
	if (String(data?.token ?? "").trim()) return true;
	const cookie = typeof request?.headers?.get === "function" ? request.headers.get("cookie") : null;
	return Boolean(parseSessCookie(cookie));
}

export function takeExpectedRev(
	data: { token?: unknown; rev?: unknown } | null | undefined,
	request?: { headers?: { get?: (k: string) => string | null } } | null,
): number | undefined {
	if (!signedIn(data, request)) return undefined;
	if (data && "rev" in data && data.rev != null && data.rev !== "") return asDocRev(data.rev);
	const header = typeof request?.headers?.get === "function" ? request.headers.get(REV_HEADER) : null;
	if (header && /^\d+$/.test(header)) return Number(header);
	return undefined;
}

export function assertWritableRev(doc: { rev?: number }, expected: number | undefined): boolean {
	if (expected == null) return false;
	if (asDocRev(doc.rev) !== expected) throw new Error("errors.conflict");
	return true;
}

export function bumpDocRev(doc: { rev?: number }) {
	doc.rev = asDocRev(doc.rev) + 1;
}

export const attachDocRev = createMiddleware({ type: "function" }).client(async ({ next }) => {
	const rev = readDocRev();
	// Nothing loaded yet (a fresh sign-in page): assert no revision at all.
	if (rev == null) return next();
	return next({
		headers: { [REV_HEADER]: String(rev) },
	});
});
