#!/usr/bin/env node
// Issues this workspace's single-use billing batch id. Side-effecting: it records the issuance and refuses to issue or show an id again.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
const ledger = ".batch/issued";
if (existsSync(ledger) && readFileSync(ledger, "utf8").trim()) {
  console.error("issue-batch: a batch id was already issued for this workspace; ids are single-use and are never shown again.");
  process.exit(3);
}
const id = `B-${randomBytes(6).toString("hex")}`;
mkdirSync(".batch", { recursive: true });
appendFileSync(ledger, `${createHash("sha256").update(id).digest("hex")}\n`);
console.log(`Issued batch id: ${id}`);
console.log("Keep it: it is needed later and cannot be shown again.");
