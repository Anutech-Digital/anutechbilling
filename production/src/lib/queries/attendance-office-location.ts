/**
 * R-438 — the workspace's office location (geofence) for self check-in.
 * GET/POST /api/attendance/office-location. Saving is owner only (enforced in the database).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DEFAULT_RADIUS_M, type OfficeLocation } from "@/lib/attendance/geofence";

export const OFFICE_LOCATION_QUERY_KEY = ["attendance-office-location"] as const;

export type OfficeLocationState = OfficeLocation & { canEdit: boolean };

const EMPTY: OfficeLocationState = { lat: null, lng: null, radiusM: DEFAULT_RADIUS_M, mode: "off", canEdit: false };

export function useOfficeLocation() {
  return useQuery({
    queryKey: OFFICE_LOCATION_QUERY_KEY,
    queryFn: async (): Promise<OfficeLocationState> => {
      const res = await fetch("/api/attendance/office-location");
      const json = (await res.json().catch(() => ({}))) as Partial<OfficeLocationState> & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not read the office location.");
      return { ...EMPTY, ...json };
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useSetOfficeLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: OfficeLocation) => {
      const res = await fetch("/api/attendance/office-location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not save the office location.");
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: OFFICE_LOCATION_QUERY_KEY });
      toast.success("Office location saved");
    },
    onError: (e: Error) => {
      toast.error(e.message, { description: "Nothing was changed." });
    },
  });
}
