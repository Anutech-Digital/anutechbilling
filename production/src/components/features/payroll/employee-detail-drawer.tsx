/**
 * EmployeeDetailDrawer — full HR profile + document vault for one employee.
 *
 * Opens from the Payroll → Employees list. Shows the profile (contact, IDs,
 * emergency contact) read-only (edit via the Employee dialog), and a document
 * vault where the owner can upload / view / delete ID proofs, resume, etc.
 * Documents live in a PRIVATE, tenant-scoped bucket; they're only ever opened
 * through a short-lived signed URL.
 */
"use client";

import * as React from "react";

import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useEmployeeDocuments, useUploadEmployeeDocument, useDeleteEmployeeDocument,
  getEmployeeDocUrl, EMPLOYEE_DOC_TYPES,
  type Employee, type EmployeeDocument,
} from "@/lib/queries/payroll";
import { rupee, formatDate } from "@/lib/utils";
import { calculateCtcBreakdown } from "@/lib/payroll/ctc";
import { DocViewerDialog } from "@/components/features/documents/doc-viewer-dialog";
import { useConfirm } from "@/components/providers/confirm-provider";

const DOC_LABEL = new Map(EMPLOYEE_DOC_TYPES.map((d) => [d.value, d.label]));

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">{label}</p>
      <p className="text-sm text-ink truncate">{value || <span className="text-ink-3">—</span>}</p>
    </div>
  );
}

export function EmployeeDetailDrawer({
  employee, open, onOpenChange, onEdit,
}: {
  employee: Employee | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
}) {
  const { data: docs, isLoading } = useEmployeeDocuments(open ? employee?.id : null);
  const upload = useUploadEmployeeDocument();
  const del = useDeleteEmployeeDocument();
  const confirm = useConfirm();
  const [docType, setDocType] = React.useState("aadhaar");
  const [viewing, setViewing] = React.useState<EmployeeDocument | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !employee) return;
    try {
      await upload.mutateAsync({ employeeId: employee.id, docType, file });
    } catch { /* hook toasts */ }
    if (fileRef.current) fileRef.current.value = "";
  };

  // Preview inside the app (modal viewer) — no popup / new-tab dependency.
  const openDoc = (doc: EmployeeDocument) => setViewing(doc);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[480px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>{employee?.name ?? "Employee"}</SheetTitle>
          <SheetDescription>
            {employee?.designation || "Employee profile & documents"}
          </SheetDescription>
        </SheetHeader>

        {!employee ? (
          <div className="flex-1 px-5 py-4"><Skeleton className="h-40" /></div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
            {/* Profile */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-ink-2">Profile</p>
                <Button size="sm" variant="ghost" icon="edit" onClick={onEdit}>Edit</Button>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-md border border-hairline bg-paper-2/30 p-3">
                <Field label="Mobile" value={employee.phone} />
                <Field label="Email" value={employee.email} />
                <Field label="Monthly salary" value={rupee(employee.monthly_gross)} />
                <Field label="Joined" value={employee.joining_date ? formatDate(employee.joining_date) : null} />
                <Field label="Date of birth" value={employee.date_of_birth ? formatDate(employee.date_of_birth) : null} />
                <Field label="Status" value={<Badge kind={employee.is_active ? "success" : "muted"} size="sm" dot>{employee.is_active ? "Active" : "Inactive"}</Badge>} />
                <Field label="PAN" value={employee.pan} />
                <Field label="PF no." value={employee.pf_no} />
                <Field label="ESI no." value={employee.esi_no} />
                <div className="col-span-2"><Field label="Address" value={employee.address} /></div>
                <Field label="Emergency contact" value={employee.emergency_contact_name} />
                <Field label="Emergency phone" value={employee.emergency_contact_phone} />
              </div>
            </div>

            {/* CTC Breakdown Card */}
            {employee && (() => {
              const ctc = calculateCtcBreakdown(employee.monthly_gross * 12);
              return (
                <div className="rounded-xl border border-hairline bg-paper p-3.5 space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-hairline">
                    <div>
                      <span className="font-bold text-ink text-sm">Monthly CTC: {rupee(ctc.monthlyCtc)}/mo</span>
                      <span className="text-[11px] text-ink-3 block">Annual Package: {rupee(ctc.annualCtc)}/yr</span>
                    </div>
                    <Badge kind="info" size="sm">CTC Breakdown</Badge>
                  </div>

                  <div className="space-y-2 text-xs">
                    {/* Earnings */}
                    <div className="bg-paper-2/50 p-2 rounded-lg border border-hairline/60">
                      <span className="font-bold text-ink block uppercase text-[9.5px] tracking-wider mb-1">1. Earnings (Gross {rupee(ctc.grossMonthly)}/mo)</span>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-ink-2">
                        <div>Basic (50%): <b className="font-mono">{rupee(ctc.basicMonthly)}</b></div>
                        <div>HRA (40%): <b className="font-mono">{rupee(ctc.hraMonthly)}</b></div>
                        {ctc.conveyanceMonthly > 0 && <div>Conveyance: <b className="font-mono">{rupee(ctc.conveyanceMonthly)}</b></div>}
                        {ctc.medicalMonthly > 0 && <div>Medical: <b className="font-mono">{rupee(ctc.medicalMonthly)}</b></div>}
                        <div className="col-span-2">Special Allowance: <b className="font-mono">{rupee(ctc.specialAllowanceMonthly)}</b></div>
                      </div>
                    </div>

                    {/* Retirals */}
                    <div className="bg-paper-2/50 p-2 rounded-lg border border-hairline/60">
                      <span className="font-bold text-amber-800 block uppercase text-[9.5px] tracking-wider mb-1">2. Employer Contributions ({rupee(ctc.totalEmployerContributionMonthly)}/mo)</span>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-ink-2">
                        <div>EPF Share: <b className="font-mono">{rupee(ctc.employerEpfShareMonthly)}</b></div>
                        <div>EPS Pension: <b className="font-mono">{rupee(ctc.employerEpsMonthly)}</b></div>
                        <div>ESI Share: <b className="font-mono">{rupee(ctc.employerEsiMonthly)}</b></div>
                        <div>Gratuity Fund: <b className="font-mono">{rupee(ctc.gratuityMonthly)}</b></div>
                      </div>
                    </div>

                    {/* Net Take Home */}
                    <div className="bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20 text-emerald-900">
                      <span className="font-bold block uppercase text-[9.5px] tracking-wider mb-1 text-emerald-800">3. Employee Net In-Hand Take Home</span>
                      <div className="flex items-center justify-between font-extrabold text-sm text-emerald-700">
                        <span>Net Payout / Month:</span>
                        <span className="font-mono">{rupee(ctc.netTakeHomeMonthly)}</span>
                      </div>
                      <div className="text-[10px] text-emerald-700 mt-1">
                        Deductions: Employee PF -{rupee(ctc.employeePfMonthly)} · PT -{rupee(ctc.professionalTaxMonthly)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Documents */}
            <div>
              <p className="text-xs font-semibold text-ink-2 mb-2">Documents</p>

              {/* Upload */}
              <div className="rounded-md border border-amber/40 bg-amber-soft/25 p-3 mb-3">
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="block text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1">Type</label>
                    <select
                      value={docType}
                      onChange={(e) => setDocType(e.target.value)}
                      className="w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                    >
                      {EMPLOYEE_DOC_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                    </select>
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*,application/pdf"
                    className="hidden"
                    onChange={onFile}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    icon="upload"
                    loading={upload.isPending}
                    onClick={() => fileRef.current?.click()}
                  >
                    Upload
                  </Button>
                </div>
                <p className="text-[11px] text-ink-3 mt-2 leading-relaxed">
                  Aadhaar, PAN, Voter ID, resume… Stored privately (only your team can open them). Images or PDF.
                </p>
              </div>

              {/* List */}
              {isLoading ? (
                <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : !docs || docs.length === 0 ? (
                <div className="rounded-md border border-dashed border-hairline bg-paper-2/20 px-4 py-6 text-center">
                  <Icon name="file" size={18} className="text-ink-3 mx-auto mb-1" />
                  <p className="text-sm text-ink-2">No documents yet</p>
                  <p className="text-[11px] text-ink-3 mt-1">Upload the employee&apos;s ID proofs & resume above.</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {docs.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 rounded-md border border-hairline bg-paper p-2.5">
                      <Icon name="file" size={16} className="text-ink-3 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-ink truncate">
                          <span className="font-medium">{DOC_LABEL.get(d.doc_type) ?? d.doc_type}</span>
                          <span className="text-ink-3"> · {d.file_name}</span>
                        </p>
                        <p className="text-[11px] text-ink-3">{formatDate(d.uploaded_at)}</p>
                      </div>
                      <Button size="sm" variant="ghost" icon="eye" onClick={() => openDoc(d)} title="View / download">View</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="trash"
                        className="!text-rose hover:!bg-rose/10"
                        loading={del.isPending}
                        title="Delete document"
                        onClick={async () => { if (await confirm({ title: `Delete "${d.file_name}"?`, body: "This permanently removes the file.", confirmLabel: "Delete", danger: true })) del.mutate(d); }}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        </SheetFooter>
      </SheetContent>

      {viewing && (
        <DocViewerDialog
          open={!!viewing}
          onOpenChange={(o) => { if (!o) setViewing(null); }}
          title={viewing.file_name}
          mimeType={viewing.mime_type}
          fileName={viewing.file_name}
          filePath={viewing.file_path}
          signer={getEmployeeDocUrl}
        />
      )}
    </Sheet>
  );
}
