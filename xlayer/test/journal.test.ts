import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ARTIFACT_URL } from "../src/artifact.ts";
import { decodeInput, encodeOutput } from "../src/bits.ts";
import { encodeJournal, encodeStep, fullReviewOf, parseJournalExport, patrolSteps, type EncodedStep, type JournalExport } from "../src/journal.ts";
import { decodeNetlist, evaluate, fromHex } from "../src/netlist.ts";
import { formatReplay, replayJournal } from "../src/replay.ts";
import { judge, patrolStage } from "../src/rule.ts";

const SAMPLE_URL = new URL("./fixtures/journal-sample.json", import.meta.url);
const sample = (): JournalExport => parseJournalExport(JSON.parse(readFileSync(SAMPLE_URL, "utf8")));

const artifact = JSON.parse(readFileSync(ARTIFACT_URL, "utf8")) as { nIn: number; nOut: number; netlist: string };
const committed = decodeNetlist(fromHex(artifact.netlist), artifact.nIn, artifact.nOut);
const localCircuit = (vector: number) => evaluate(committed, vector);
const ruleFunction = (vector: number) => encodeOutput(judge(decodeInput(vector)));

const pool = (digit: string) => `0x${digit.repeat(40)}`;

/** The encoded step of a pool at a time, from the sample. */
function stepOf(encoded: readonly EncodedStep[], digit: string, at: string): EncodedStep {
  const found = encoded.find((item) => item.step.pool === pool(digit) && item.step.at === at);
  assert.ok(found, `no step for pool ${digit} at ${at}`);
  return found;
}

function replayable(item: EncodedStep) {
  assert.equal(item.kind, "replayable", item.kind === "not_replayable" ? item.reason : "");
  return item as Extract<EncodedStep, { kind: "replayable" }>;
}

test("an export is checked before anything is replayed", () => {
  const good = JSON.parse(readFileSync(SAMPLE_URL, "utf8")) as Record<string, unknown> & { lines: Record<string, unknown>[] };
  assert.doesNotThrow(() => parseJournalExport(good));
  assert.throws(() => parseJournalExport({ ...good, chainId: 1 }), /chainId: expected 91342/u);
  const withLine = (patch: Record<string, unknown>) => ({ ...good, lines: [{ ...good.lines[0], ...patch }] });
  assert.throws(() => parseJournalExport(withLine({ pool: pool("A") })), /lines\[0\]: pool is not a lowercase address/u);
  assert.throws(() => parseJournalExport(withLine({ at: "2026-11-20 01:00:00" })), /lines\[0\]: at is not an ISO time in UTC/u);
  assert.throws(() => parseJournalExport(withLine({ at: "2026-11-20T01:00:00+09:00" })), /at is not an ISO time in UTC/u);
  assert.throws(() => parseJournalExport(withLine({ actor: "someone" })), /unknown actor/u);
  assert.throws(() => parseJournalExport(withLine({ evidence: null })), /evidence is not an object/u);
  assert.throws(() => parseJournalExport({ ...good, pools: [{ pool: pool("1") }] }), /pools\[0\]: family is not a string/u);
});

test("lines group into patrol steps; operator lines and trade checks are not steps", () => {
  const { steps, other } = patrolSteps(sample());
  assert.equal(steps.length, 15);
  assert.deepEqual(
    other.map((line) => `${line.actor} ${line.reason}`),
    ["probe trade_check", "operator operator_blocked"],
  );
  // A trade check is not a patrol step even if it carries a fingerprint: it would count as an unchanged step.
  const journal = sample();
  const marked: JournalExport = {
    ...journal,
    lines: journal.lines.map((line) => (line.reason === "trade_check" ? { ...line, fingerprint: `0x${"ee".repeat(32)}` } : line)),
  };
  assert.equal(patrolSteps(marked).steps.length, 15);
  // A step keeps its lines in write order.
  const first = steps.find((step) => step.pool === pool("1") && step.at === "2026-11-20T01:00:00.000Z");
  assert.deepEqual(first?.lines.map((line) => line.actor), ["probe", "role", "role", "trust_rule"]);
});

test("the encoder follows the DES-704 notes: skipped pools get decision 0, pin 18 is an AND, watch-only stays shut", () => {
  const { encoded } = encodeJournal(sample());

  // Deferred review after a fee change: no judgment, so no decision; the reflex alone restricts.
  const deferred = replayable(stepOf(encoded, "1", "2026-11-20T03:00:00.000Z"));
  assert.equal(deferred.input.decision, null);
  assert.equal(deferred.input.stage, "probation");
  assert.deepEqual([...deferred.input.changes], ["fee_changed"]);
  assert.equal(deferred.serverStage, "restricted");

  // A change with no reflex line (stale) is taken from the probe line.
  const stale = replayable(stepOf(encoded, "1", "2026-11-20T04:00:00.000Z"));
  assert.deepEqual([...stale.input.changes], ["stale"]);

  // Watch-only family: the AI is not called, decision 0.
  const watchOnly = replayable(stepOf(encoded, "5", "2026-11-20T01:20:00.000Z"));
  assert.equal(watchOnly.input.decision, null);
  assert.equal(watchOnly.input.family, "pancake_infinity_cl");
  assert.equal(watchOnly.serverStage, "unknown");

  // Pin 18: the judge read clear tokens, this step's reading is risky. Clear only when both are.
  const tokens = replayable(stepOf(encoded, "4", "2026-11-20T01:15:00.000Z"));
  assert.equal(tokens.input.decision, "allow");
  assert.equal(tokens.input.tokenPermissionsClear, false);
  assert.equal(patrolStage(tokens.input), tokens.serverStage);
  // With the judge's reading alone the circuit would open a pool the server kept shut.
  assert.equal(patrolStage({ ...tokens.input, tokenPermissionsClear: true }), "probation");
  assert.equal(tokens.serverStage, "unknown");

  // The admin handle path is the only way a restrict proposes restricted from unknown.
  const admin = replayable(stepOf(encoded, "3", "2026-11-20T01:10:00.000Z"));
  assert.equal(admin.input.decision, "restrict");
  assert.equal(admin.input.adminHandleRestrict, true);
  assert.equal(admin.input.fullReview, true);
  assert.equal(admin.serverStage, "restricted");

  // A code change is a full review even when the pool is known; the reflex blocked first.
  const code = replayable(stepOf(encoded, "2", "2026-11-20T05:00:00.000Z"));
  assert.equal(code.input.stage, "unknown");
  assert.deepEqual([...code.input.changes], ["code_changed"]);
  assert.equal(code.input.fullReview, true);
  assert.equal(code.serverStage, "probation");

  // A partial review's allow is read back as restrict (it was lowered to the current stage): same stage.
  const partial = replayable(stepOf(encoded, "7", "2026-11-21T01:05:00.000Z"));
  assert.equal(partial.input.decision, "restrict");
  assert.equal(partial.input.fullReview, false);
  assert.equal(partial.serverStage, "restricted");

  // A reused judgment on a pool never opened: the reason reads as no change, but the gate reviews an unknown pool in full.
  const reused = replayable(stepOf(encoded, "8", "2026-11-21T01:10:00.000Z"));
  assert.equal(reused.input.fullReview, true);
  assert.equal(reused.input.decision, "allow");
  assert.equal(reused.stepKind, "judged");
  assert.equal(reused.serverStage, "probation");

  // Step kinds: judged, reflex only, unchanged.
  assert.equal(replayable(stepOf(encoded, "1", "2026-11-20T01:00:00.000Z")).stepKind, "judged");
  assert.equal(deferred.stepKind, "reflex_only");
  assert.equal(stale.stepKind, "unchanged");
  assert.equal(watchOnly.stepKind, "unchanged");

  // The lane-only pins are fixed: the journal has no lane.
  for (const item of encoded) {
    if (item.kind !== "replayable") continue;
    assert.equal(item.input.operatorBlocked, false);
    assert.equal(item.input.cardFresh, true);
    assert.equal(item.input.amountWithinCap, true);
  }
});

test("a full review is rebuilt as the server's gate decides it: reason, stage before the reflex, or a code change", () => {
  const none = new Set<never>();
  assert.equal(fullReviewOf("first_seen", "probation", none), true);
  assert.equal(fullReviewOf("full_review_requested", "trusted", none), true);
  assert.equal(fullReviewOf("no_change", "unknown", none), true);
  assert.equal(fullReviewOf("no_change", "blocked", none), true);
  assert.equal(fullReviewOf("fee_changed", "trusted", new Set(["fee_changed", "token_code_changed"] as const)), true);
  assert.equal(fullReviewOf("fee_changed", "restricted", new Set(["fee_changed"] as const)), false);
  assert.equal(fullReviewOf("no_change", "probation", none), false);
});

test("a family the circuit does not know is a newer rule: counted apart, never a difference", () => {
  const { encoded } = encodeJournal(sample());
  const later = stepOf(encoded, "b", "2026-11-26T09:00:00.000Z");
  assert.equal(later.kind, "newer_rule");
  assert.equal(later.kind === "newer_rule" && later.family, "joseon_v2");
  // Replayed anyway, the circuit (which never opens a family outside its list) would keep the pool shut that the
  // server opened: a difference that is only the circuit's age.
  const journal = sample();
  const asKnown = new Map(journal.pools.map((entry) => [entry.pool, entry.pool === pool("b") ? "pancake_infinity_cl" : entry.family] as const));
  const forced = replayable(encodeStep(later.step, asKnown));
  assert.notEqual(patrolStage(forced.input), forced.serverStage);
});

test("a recorded proposal the circuit's rules cannot give is kept as a difference, with both proposals", async () => {
  const { encoded } = encodeJournal(sample());
  const outside = replayable(stepOf(encoded, "a", "2026-11-21T01:20:00.000Z"));
  assert.equal(outside.stepKind, "judged");
  assert.deepEqual(outside.proposalOutsideRules, { recorded: "probation", rules: "restricted" });
  const report = await replayJournal(sample(), localCircuit);
  const difference = report.differences.find((d) => d.pool === pool("a"));
  assert.deepEqual(difference && { reason: difference.reason, proposal: difference.proposal, server: difference.server, circuit: difference.circuit }, {
    reason: "proposal_outside_rules",
    proposal: { recorded: "probation", rules: "restricted" },
    server: "probation",
    circuit: "restricted",
  });
  // It counts in the denominator and is a difference even if the circuit's stage happened to match the server's.
  const lucky = await replayJournal(sample(), (vector) => (vector === difference!.vector ? encodeOutput({ ...judge(decodeInput(vector)), stage: "probation" }) : localCircuit(vector)));
  assert.equal(lucky.differences.find((d) => d.pool === pool("a"))?.reason, "proposal_outside_rules");
  assert.deepEqual(lucky.byKind.judged, { replayed: 9, same: 8 });
});

test("steps the journal cannot rebuild are counted apart, never guessed", () => {
  const { encoded } = encodeJournal(sample());
  const noProbe = stepOf(encoded, "9", "2026-11-21T01:15:00.000Z");
  assert.equal(noProbe.kind === "not_replayable" && noProbe.reason, "noProbeLine");

  // A judged pool without a card family, and a proposal outside the list.
  const journal = sample();
  const families = new Map(journal.pools.filter((entry) => entry.pool !== pool("1")).map((entry) => [entry.pool, entry.family] as const));
  const step = patrolSteps(journal).steps.find((item) => item.pool === pool("1") && item.at === "2026-11-20T01:00:00.000Z");
  assert.ok(step);
  assert.equal(encodeStep(step, families).kind === "not_replayable" && (encodeStep(step, families) as { reason: string }).reason, "noFamily");
  const odd = { ...step, lines: step.lines.map((line) => (line.actor === "trust_rule" ? { ...line, evidence: { ...line.evidence, proposedState: "open" } } : line)) };
  const all = new Map(journal.pools.map((entry) => [entry.pool, entry.family] as const));
  assert.equal((encodeStep(odd, all) as { reason?: string }).reason, "proposalUnreadable");
  const noJudge = { ...step, lines: step.lines.filter((line) => !(line.actor === "role" && line.detail === "judge")) };
  assert.equal((encodeStep(noJudge, all) as { reason?: string }).reason, "noJudgeLine");
});

test("replaying the sample: the committed netlist and the rule function both give the server's stage on every step the rules cover", async () => {
  for (const circuit of [localCircuit, ruleFunction]) {
    const report = await replayJournal(sample(), circuit);
    assert.equal(report.lines, 42);
    assert.equal(report.steps, 15);
    assert.equal(report.otherLines, 2);
    assert.deepEqual(report.otherByReason, { "probe trade_check": 1, "operator operator_blocked": 1 });
    assert.equal(report.replayed, 13);
    assert.equal(report.same, 12);
    assert.deepEqual(report.byKind, { judged: { replayed: 9, same: 8 }, reflex_only: { replayed: 1, same: 1 }, unchanged: { replayed: 3, same: 3 } });
    // The one difference is the made-up line whose proposal is outside the rules.
    assert.deepEqual(
      report.differences.map((d) => [d.pool, d.reason]),
      [[pool("a"), "proposal_outside_rules"]],
    );
    assert.deepEqual(report.notReplayable, { noProbeLine: 1, stageNotInList: 0, noJudgeLine: 0, proposalUnreadable: 0, noFamily: 0 });
    assert.deepEqual(report.newerRule, [{ pool: pool("b"), at: "2026-11-26T09:00:00.000Z", family: "joseon_v2" }]);
    assert.ok(report.vectors <= report.replayed);
  }
  const text = formatReplay(await replayJournal(sample(), localCircuit));
  // The headline counts judged steps only, so steps where nothing could differ do not swell it.
  assert.match(text, /^8 of 9 judged patrol steps agree: the circuit gives the stage the server wrote\n/u);
  assert.match(text, /\n {2}lines outside patrol steps: operator operator_blocked 1 · probe trade_check 1\n/u);
  assert.match(text, /\nby kind: judged 8 of 9 · reflex only 1 of 1 · unchanged 3 of 3 · all 12 of 13\n/u);
  assert.match(text, /differences 1: the circuit's stage 0 · a recorded proposal outside the circuit's rules 1/u);
  assert.match(text, /proposal outside the rules: recorded probation, the circuit's rules give restricted from the journal's facts {2}server probation {2}circuit restricted/u);
  assert.match(text, /not replayable, no probe line in the step: 1/u);
  assert.match(text, /newer rule than the circuit, a family the circuit does not know \(joseon_v2\): 1/u);
});

test("a difference is listed with the pool, the time, the server's stage and the circuit's", async () => {
  const journal = sample();
  // The server wrote probation where the rules keep the pool restricted (a partial review cannot open).
  const tampered: JournalExport = {
    ...journal,
    lines: journal.lines.map((line) => (line.pool === pool("7") && line.actor === "trust_rule" ? { ...line, after: "probation" } : line)),
  };
  const report = await replayJournal(tampered, localCircuit);
  assert.equal(report.same, 11);
  assert.deepEqual(report.byKind.judged, { replayed: 9, same: 7 });
  assert.deepEqual(
    report.differences.filter((d) => d.reason === "stage").map(({ pool: p, at, stepKind, server, circuit }) => ({ p, at, stepKind, server, circuit })),
    [{ p: pool("7"), at: "2026-11-21T01:05:00.000Z", stepKind: "judged", server: "probation", circuit: "restricted" }],
  );
  assert.match(formatReplay(report), /^7 of 9 judged/u);
  assert.match(formatReplay(report), new RegExp(`${pool("7")}  2026-11-21T01:05:00.000Z  judged  stage  server probation  circuit restricted`, "u"));

  // A circuit that answers wrongly is caught the same way.
  const broken = (vector: number) => encodeOutput({ ...judge(decodeInput(vector)), stage: "trusted" });
  assert.equal((await replayJournal(journal, broken)).same, 0);
});

test("the circuit is asked once per distinct input", async () => {
  const asked: number[] = [];
  const report = await replayJournal(sample(), (vector) => {
    asked.push(vector);
    return localCircuit(vector);
  });
  assert.equal(asked.length, new Set(asked).size);
  assert.equal(asked.length, report.vectors);
});
