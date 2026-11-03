"use client";
/**
 * R-2408 — search a customer (or invoice number), filter by owner and age, sort. Sits between
 * the age tiles and the list (audit #7: no sort / filter / search).
 */
import * as React from "react";

import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AGE_LABEL, AGE_VIEWS, SORT_KEYS, SORT_LABEL, UNASSIGNED, type AgeView, type SortKey } from "./worklist";

const ANY = "any";

export function WorklistToolbar({
  q, onQ, owner, onOwner, owners, ownerLabel, age, onAge, sort, onSort,
}: {
  q: string;
  onQ: (v: string) => void;
  /** "" = everyone. */
  owner: string;
  onOwner: (v: string) => void;
  owners: readonly string[];
  ownerLabel: (key: string) => string;
  age: AgeView;
  onAge: (v: AgeView) => void;
  sort: SortKey;
  onSort: (v: SortKey) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Input
        type="search"
        value={q}
        onChange={(e) => onQ(e.target.value)}
        placeholder="Search customer or invoice no."
        aria-label="Search customer or invoice number"
        prefix={<Icon name="search" size={14} />}
        wrapperClassName="w-full sm:w-64"
      />
      <Select value={owner || ANY} onValueChange={(v) => onOwner(v === ANY ? "" : v)}>
        <SelectTrigger aria-label="Owner" className="w-full sm:w-44"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Every owner</SelectItem>
          {owners.map((k) => <SelectItem key={k} value={k}>{k === UNASSIGNED ? "Unassigned" : ownerLabel(k)}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={age} onValueChange={(v) => onAge(v as AgeView)}>
        <SelectTrigger aria-label="Age" className="w-full sm:w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          {AGE_VIEWS.map((k) => <SelectItem key={k} value={k}>{AGE_LABEL[k]}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={sort} onValueChange={(v) => onSort(v as SortKey)}>
        <SelectTrigger aria-label="Sort" className="w-full sm:w-44"><SelectValue /></SelectTrigger>
        <SelectContent>
          {SORT_KEYS.map((k) => <SelectItem key={k} value={k}>Sort: {SORT_LABEL[k]}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
