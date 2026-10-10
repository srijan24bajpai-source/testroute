"use client";
import { useState } from "react";

export default function Account() {
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");

  async function exportData() {
    const res = await fetch("/api/account");
    if (!res.ok) return setMsg("Please sign in to export your data.");
    const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "my-data.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function remove() {
    const res = await fetch("/api/account?confirm=DELETE", { method: "DELETE" });
    const data = await res.json();
    setMsg(res.ok ? `Account deleted. ${data.deletedTrips} saved trip(s) erased; ${data.retainedBookings} booking record(s) retained only where transaction records must be kept.` : data?.error?.message ?? "Could not delete the account.");
  }

  return (
    <>
      <h1>Account &amp; data</h1>
      <section className="card">
        <h2>Export your data</h2>
        <button type="button" onClick={exportData}>Download my data (JSON)</button>
      </section>
      <section className="card">
        <h2>Delete my account</h2>
        <p className="muted">Erases saved journeys and quotes and removes your login. Booking records that providers or tax/transaction rules require us to keep are retained in minimal form.</p>
        <label htmlFor="c">Type DELETE to confirm</label>
        <input id="c" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        <button type="button" className="primary" style={{ marginTop: 8 }} disabled={confirmText !== "DELETE"} onClick={remove}>Delete account</button>
      </section>
      {msg && <p role="status">{msg}</p>}
    </>
  );
}
