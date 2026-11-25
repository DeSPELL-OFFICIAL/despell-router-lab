import type { PinRow } from "@/lib/circuit/pins";

export function PinTable({ rows, caption }: { rows: readonly PinRow[]; caption?: string }) {
  return (
    <div className="lab-table-wrap">
      <table className="lab-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            <th scope="col">Pin</th>
            <th scope="col">Name</th>
            <th scope="col">Bits</th>
            <th scope="col">Value</th>
            <th scope="col">Meaning</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.pins}>
              <td className="ds-mono">{r.pins}</td>
              <td className="ds-mono">{r.name}</td>
              <td className="ds-mono">{r.bits}</td>
              <td>{r.value}</td>
              <td className="ds-dim">{r.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
