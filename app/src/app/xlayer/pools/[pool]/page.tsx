import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { encodeOutput } from "@despell-lab/xlayer/src/bits.ts";
import { PinTable } from "@/components/circuit/pin-table";
import { RejudgePanel } from "@/components/circuit/rejudge-panel";
import { CIRCUIT, DEPLOYMENT, evaluateLocally, X_LAYER } from "@/lib/circuit/circuit";
import { sameJudgment } from "@/lib/circuit/check";
import { inputRows, outputRows } from "@/lib/circuit/pins";
import { serverJudgmentForPool } from "@/lib/circuit/server-judgment";
import { short } from "@/lib/swap/format";
import { swapChain } from "@/lib/swap/chains";

export const metadata: Metadata = { title: "Pool judgment circuit · X Layer TapeOut" };

const hex32 = (n: number) => `0x${(n >>> 0).toString(16).padStart(7, "0")}`;

export default async function Page(props: PageProps<"/xlayer/pools/[pool]">) {
  const { pool } = await props.params;
  const demoMismatch = (await props.searchParams).demo === "mismatch";
  const server = serverJudgmentForPool(pool, { demoMismatch });
  if (!server) notFound();
  const chain = swapChain(server.chainId);
  const local = evaluateLocally(server.input);

  return (
    <main className="lab-main">
      <div style={{ display: "grid", gap: 12 }}>
        <p className="lab-eyebrow">X Layer TapeOut · pool judgment circuit</p>
        <h1 className="lab-h1">
          {server.label} <span className="lab-h1-sub">· {chain.name}</span>
        </h1>
        <p className="lab-lede">
          The router&apos;s rules for this pool, built as a NAND circuit and taped out on X Layer. Anyone can send the same 27 input bits to the circuit&apos;s{" "}
          <code>eval</code> and get the judgment back; the app compares it with the server&apos;s and stops the swap card when they differ.{" "}
          <Link href={demoMismatch ? "/xlayer?demo=mismatch" : "/xlayer"}>Back to the card</Link>
        </p>
        {demoMismatch && (
          <p className="lab-demo-note" role="note">
            Demo: the server&apos;s judgment below is altered on purpose, to show what a mismatch does.
          </p>
        )}
      </div>

      <section className="lab-panel" aria-labelledby="circuit-h">
        <h2 id="circuit-h" className="lab-h2">
          Circuit
        </h2>
        <dl className="lab-facts">
          <dt>Chain</dt>
          <dd>
            {X_LAYER.name} · {X_LAYER.id}
          </dd>
          <dt>Processor</dt>
          <dd className="ds-mono">
            <a href={`${X_LAYER.explorer}/address/${DEPLOYMENT.processor}`} target="_blank" rel="noreferrer">
              {DEPLOYMENT.processor}
            </a>
          </dd>
          <dt>Circuit ID</dt>
          <dd className="ds-mono">#{String(DEPLOYMENT.circuitId)}</dd>
          <dt>NAND gates</dt>
          <dd>{CIRCUIT.nand}</dd>
          <dt>Pins</dt>
          <dd>
            {CIRCUIT.nIn} in · {CIRCUIT.nOut} out
          </dd>
          <dt>Netlist</dt>
          <dd>
            {CIRCUIT.bytes.toLocaleString("en-US")} bytes · sha256 <span className="ds-mono">{short(`0x${CIRCUIT.sha256}`)}</span> · rule version {CIRCUIT.ruleVersion}
          </dd>
          <dt>Pool</dt>
          <dd className="ds-mono">
            <a href={`${chain.explorer}/address/${server.pool}`} target="_blank" rel="noreferrer">
              {server.pool}
            </a>
          </dd>
        </dl>
      </section>

      <section className="lab-panel" aria-labelledby="server-h">
        <h2 id="server-h" className="lab-h2">
          Server judgment
        </h2>
        <p>
          <b>
            {server.judgment.stage}, {server.judgment.lane} lane
          </b>{" "}
          <span className="ds-dim">
            · {server.at.replace("T", " ").replace(":00Z", " UTC")} · a recorded sample until the router journal is connected
          </span>
        </p>
        <PinTable rows={outputRows(encodeOutput(server.judgment))} />
      </section>

      <section className="lab-panel" aria-labelledby="inputs-h">
        <h2 id="inputs-h" className="lab-h2">
          Input bits
        </h2>
        <p className="lab-note">
          The facts the server judged on, as the circuit&apos;s 27 input pins. Vector <span className="ds-mono">{hex32(local.vector)}</span>, packed little end first
          for <code>eval</code>.
        </p>
        <PinTable rows={inputRows(local.vector)} />
      </section>

      <RejudgePanel chainId={server.chainId} pool={server.pool} demoMismatch={demoMismatch} />

      <section className="lab-panel" aria-labelledby="local-h">
        <h2 id="local-h" className="lab-h2">
          The same netlist, evaluated here
        </h2>
        <p className="lab-note">
          The committed netlist run gate by gate on this page, the way <code>eval</code> runs it on chain:{" "}
          <b>
            {local.judgment.stage}, {local.judgment.lane} lane
          </b>{" "}
          ({sameJudgment(local.judgment, server.judgment) ? "same as the server" : "differs from the server"}).
        </p>
      </section>
    </main>
  );
}
