"use client";
/**
 * R-2433 (G-NETWORK N1) — Settings → Network: connect with another business on ResellerOS.
 *
 * Identity is the VERIFIED GSTIN on both sides. One business sends a request, the other's
 * owner accepts; each side ticks what IT shares; either owner can revoke (nothing new flows
 * after that). Suggestions: a customer's / vendor's GSTIN that belongs to a verified business
 * here — never a personal workspace. Group link = sister company, marked related party, still
 * accepted by both owners. Spec: docs/specs/g-network.md.
 *
 * Every read/write is a SECURITY DEFINER function (lib/network/client.ts) — this screen never
 * reads the other company's data itself.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { LoadErrorInline } from "@/components/shared/load-error";
import { useConfirm } from "@/components/providers/confirm-provider";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { toastError } from "@/lib/errors/toast-error";
import {
  NETWORK_SCOPES, SCOPE_HINT, SCOPE_LABEL, LIVE_SCOPES, scopesSentence, toggleScope,
  normalizeGstinInput, looksLikeGstin, type NetworkScope,
} from "@/lib/network/scopes";
import {
  listConnections, listSuggestions, requestConnection, respondConnection, revokeConnection, setMyScopes,
  type NetworkConnection,
} from "@/lib/network/client";

const KEY = ["settings", "network"] as const;

function ScopeTicks({
  value, onChange, disabled, idPrefix,
}: { value: NetworkScope[]; onChange: (next: NetworkScope[]) => void; disabled?: boolean; idPrefix: string }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {NETWORK_SCOPES.map((s) => (
        <label key={s} htmlFor={`${idPrefix}-${s}`} className="flex items-start gap-2 text-sm text-ink">
          <Checkbox
            id={`${idPrefix}-${s}`}
            className="mt-0.5"
            checked={value.includes(s)}
            disabled={disabled}
            onCheckedChange={(c) => onChange(toggleScope(value, s, c === true))}
          />
          <span>
            {SCOPE_LABEL[s]}
            <span className="block text-xs text-ink-3">{SCOPE_HINT[s]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

export function NetworkTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: me } = useCurrentUser();
  const isOwner = me?.role === "owner";

  const conns = useQuery({ queryKey: [...KEY, "connections"], queryFn: listConnections });
  const sugg = useQuery({ queryKey: [...KEY, "suggestions"], queryFn: listSuggestions, enabled: isOwner });

  const [gstin, setGstin] = React.useState("");
  const [related, setRelated] = React.useState(false);
  const [askScopes, setAskScopes] = React.useState<NetworkScope[]>([]);
  const [answerScopes, setAnswerScopes] = React.useState<Record<string, NetworkScope[]>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLDivElement>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  async function run(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
    try {
      await fn();
      toast.success(ok);
      await refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  const sendRequest = () => {
    const g = normalizeGstinInput(gstin);
    if (!looksLikeGstin(g)) {
      toast.error("Enter a 15-character GSTIN.", { description: "Example: 07ABCDE1234F1Z5 — the GSTIN of the business you want to connect with." });
      return;
    }
    void run("send", async () => {
      await requestConnection(g, askScopes, related);
      setGstin(""); setRelated(false); setAskScopes([]);
    }, "Request sent. Their owner sees it under Settings → Network.");
  };

  const all = conns.data ?? [];
  const received = all.filter((c) => c.status === "requested" && c.direction === "received");
  const sent = all.filter((c) => c.status === "requested" && c.direction === "sent");
  const connected = all.filter((c) => c.status === "accepted");
  const past = all.filter((c) => c.status === "rejected" || c.status === "revoked").slice(0, 5);

  const revoke = async (c: NetworkConnection) => {
    if (!(await confirm({
      title: c.status === "requested" ? `Withdraw the request to ${c.otherName}?` : `Disconnect from ${c.otherName}?`,
      body: c.status === "requested"
        ? "They will no longer see your request."
        : "Everything shared through this connection stops at once, both ways. Documents already delivered stay as they are.",
      confirmLabel: c.status === "requested" ? "Withdraw" : "Disconnect",
      danger: true,
    }))) return;
    void run(c.id, () => revokeConnection(c.id), c.status === "requested" ? "Request withdrawn." : `Disconnected from ${c.otherName}.`);
  };

  if (conns.isError) return <LoadErrorInline what="Your business connections" error={conns.error} onRetry={() => void conns.refetch()} />;

  return (
    <div className="max-w-3xl space-y-5">
      <Card className="p-5 md:p-6">
        <h2 className="font-serif text-xl text-ink">Network</h2>
        <p className="mt-1 text-sm text-ink-3">
          Connect with your customers and vendors who also use ResellerOS, by verified GSTIN. They accept, and each of you
          chooses what to share. Partner metrics work today; invoices, payments, statements, purchase orders and the
          catalogue start flowing in the next updates.
        </p>
        {!isOwner && me && (
          <p className="mt-3 text-sm text-ink-2">Only the workspace owner can connect, accept or disconnect.</p>
        )}
      </Card>

      {isOwner && (sugg.data?.length ?? 0) > 0 && (
        <Card className="p-5 md:p-6">
          <h3 className="text-base font-semibold text-ink">On ResellerOS too</h3>
          <ul className="mt-3 divide-y divide-hairline">
            {sugg.data!.map((s) => (
              <li key={s.tenantId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{s.tenantName} is on ResellerOS — connect?</p>
                  <p className="text-xs text-ink-3">
                    Your {s.matchedAs} “{s.matchedName}” · GSTIN {s.gstin}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setGstin(s.gstin);
                    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  Connect
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {received.length > 0 && (
        <Card className="p-5 md:p-6">
          <h3 className="text-base font-semibold text-ink">Requests received</h3>
          <ul className="mt-3 space-y-4">
            {received.map((c) => {
              const mine = answerScopes[c.id] ?? [];
              return (
                <li key={c.id} className="rounded-lg border border-hairline p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink">{c.otherName}</p>
                    <span className="text-xs text-ink-3">GSTIN {c.otherGstin}</span>
                    {c.relatedParty && <Badge kind="info" size="sm">Group company · related party</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-ink-3">They will share: {scopesSentence(c.theirScopes)}</p>
                  {isOwner && (
                    <>
                      <p className="mt-3 mb-2 text-xs font-medium text-ink-2">What you share with them</p>
                      <ScopeTicks idPrefix={`ans-${c.id}`} value={mine} onChange={(v) => setAnswerScopes((m) => ({ ...m, [c.id]: v }))} />
                      <div className="mt-4 flex gap-2">
                        <Button size="sm" variant="primary" disabled={busy !== null}
                          onClick={() => void run(c.id, () => respondConnection(c.id, true, mine), `Connected with ${c.otherName}.`)}>
                          Accept
                        </Button>
                        <Button size="sm" disabled={busy !== null}
                          onClick={() => void run(c.id, () => respondConnection(c.id, false, []), "Request declined.")}>
                          Decline
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card className="p-5 md:p-6">
        <h3 className="text-base font-semibold text-ink">Connected businesses</h3>
        {conns.isLoading ? (
          <p className="mt-3 text-sm text-ink-3">Loading…</p>
        ) : connected.length === 0 && sent.length === 0 ? (
          <p className="mt-3 text-sm text-ink-3">No connections yet.</p>
        ) : (
          <ul className="mt-3 space-y-4">
            {connected.map((c) => (
              <li key={c.id} className="rounded-lg border border-hairline p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink">{c.otherName}</p>
                    <span className="text-xs text-ink-3">GSTIN {c.otherGstin ?? "—"}</span>
                    <Badge kind="success" size="sm" dot>Connected</Badge>
                    {c.relatedParty && <Badge kind="info" size="sm">Related party</Badge>}
                    {c.origin === "parent_link" && <Badge kind="muted" size="sm">Partner link</Badge>}
                  </div>
                  {isOwner && (
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void revoke(c)}>
                      Disconnect
                    </Button>
                  )}
                </div>
                <p className="mt-1 text-xs text-ink-3">They share with you: {scopesSentence(c.theirScopes)}</p>
                <p className="mt-3 mb-2 text-xs font-medium text-ink-2">What you share with them</p>
                <ul className="space-y-2">
                  {NETWORK_SCOPES.map((s) => (
                    <li key={s} className="flex items-start justify-between gap-4">
                      <label htmlFor={`share-${c.id}-${s}`} className="text-sm text-ink">
                        {SCOPE_LABEL[s]}
                        {!LIVE_SCOPES.includes(s) && <span className="ml-1 text-xs text-ink-3">(next updates)</span>}
                        <span className="block text-xs text-ink-3">{SCOPE_HINT[s]}</span>
                      </label>
                      <Switch
                        id={`share-${c.id}-${s}`}
                        checked={c.myScopes.includes(s)}
                        disabled={!isOwner || busy !== null}
                        onCheckedChange={(on) => void run(c.id, () => setMyScopes(c.id, toggleScope(c.myScopes, s, on)),
                          on ? `${SCOPE_LABEL[s]} now shared with ${c.otherName}.` : `${SCOPE_LABEL[s]} no longer shared with ${c.otherName}.`)}
                      />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            {sent.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-ink">{c.otherName}</p>
                  <span className="text-xs text-ink-3">GSTIN {c.otherGstin}</span>
                  <Badge kind="warning" size="sm" dot>Waiting for them to accept</Badge>
                </div>
                {isOwner && (
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void revoke(c)}>
                    Withdraw
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {isOwner && (
        <div ref={formRef} className="scroll-mt-20">
          <Card className="p-5 md:p-6">
            <h3 className="text-base font-semibold text-ink">Connect by GSTIN</h3>
            <p className="mt-1 text-sm text-ink-3">Both GSTINs must be verified. Their owner has to accept.</p>
            <div className="mt-4 max-w-sm">
              <label htmlFor="network-gstin" className="mb-1 block text-xs font-medium text-ink-3">Their GSTIN</label>
              <Input id="network-gstin" value={gstin} maxLength={20} placeholder="07ABCDE1234F1Z5"
                onChange={(e) => setGstin(e.target.value)} />
            </div>
            <p className="mt-4 mb-2 text-xs font-medium text-ink-2">What you share with them</p>
            <ScopeTicks idPrefix="ask" value={askScopes} onChange={setAskScopes} />
            <label htmlFor="network-related" className="mt-4 flex items-start gap-2 text-sm text-ink">
              <Checkbox id="network-related" className="mt-0.5" checked={related} onCheckedChange={(c) => setRelated(c === true)} />
              <span>
                Group company (same owner)
                <span className="block text-xs text-ink-3">Marked as a related party. Their owner still accepts.</span>
              </span>
            </label>
            <div className="mt-5">
              <Button variant="primary" disabled={busy !== null || gstin.trim() === ""} onClick={sendRequest}>
                {busy === "send" ? "Sending…" : "Send request"}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {past.length > 0 && (
        <Card className="p-5 md:p-6">
          <h3 className="text-base font-semibold text-ink">Earlier</h3>
          <ul className="mt-2 divide-y divide-hairline">
            {past.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="text-ink">{c.otherName}</span>
                <span className="text-xs text-ink-3">
                  {c.status === "rejected" ? "Declined" : c.revokedByMe ? "You disconnected" : "They disconnected"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
