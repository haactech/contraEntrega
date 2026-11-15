import { useMemo, useRef } from "react";
import type { BuyerAgreementView, SellerAgreementView } from "@trato/shared";
import { api } from "@/lib/api";
import { TaskChecklist, type ChecklistActions } from "./task-checklist";

type Props = {
  compact?: boolean;
  showTimeline?: boolean;
  /** Re-fetch the agreement after any mutation (and when a signed photo URL expired). */
  refresh: () => Promise<void> | void;
  onPay?: () => void;
  onShare?: () => void;
  focusTask?: { id: string; nonce: number } | null;
} & ({ role: "SELLER"; view: SellerAgreementView } | { role: "BUYER"; view: BuyerAgreementView; token: string });

/** Wires `TaskChecklist` to the API for the seller (agreement id) or the buyer (share token). */
export function TaskChecklistContainer(props: Props) {
  const { view, refresh } = props;
  const agreementId = view.agreement.id;
  const lastImageRefresh = useRef(0);
  const token = props.role === "BUYER" ? props.token : null;

  const actions: ChecklistActions = useMemo(() => {
    const done = async () => void (await refresh());
    if (props.role === "SELLER") {
      return {
        uploadPhoto: async (task, file) => {
          const { compressImage } = await import("@/lib/image");
          const out = await compressImage(file);
          await api.uploadTaskEvidence(agreementId, task.id, out.blob, out.filename, "AFTER");
          await done();
        },
        removePhoto: async (task, photo) => {
          await api.deleteTaskEvidence(agreementId, task.id, photo.id);
          await done();
        },
        submitTask: async (task) => {
          await api.submitTask(agreementId, task.id);
          await done();
        },
        ...(props.onShare ? { onShare: props.onShare } : {}),
      };
    }
    return {
      approveTask: async (task) => {
        if (token) await api.approveTask(token, task.id);
        await done();
      },
      requestAdjustment: async (task, reason) => {
        if (token) await api.requestTaskAdjustment(token, task.id, reason);
        await done();
      },
      ...(props.onPay ? { onPay: props.onPay } : {}),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.role, agreementId, token, refresh, props.onPay, props.onShare]);

  if (!view.tasks || !view.taskProgress) return null;
  const a = view.agreement;
  const balance = view.milestones.find((m) => m.kind === "BALANCE") ?? null;
  const counterpart =
    props.role === "BUYER" ? (props.view.seller.displayName || "el prestador") : a.buyerAcceptedName ?? a.buyerName;

  return (
    <TaskChecklist
      role={props.role}
      title={a.title}
      totalCents={a.totalCents}
      agreementStatus={a.status}
      balance={balance}
      tasks={view.tasks}
      progress={view.taskProgress}
      counterpartName={counterpart}
      actions={actions}
      compact={props.compact ?? false}
      focusTask={props.focusTask ?? null}
      {...(props.showTimeline ? { events: view.events, milestones: view.milestones } : {})}
      onImageError={() => {
        // Signed photo URLs expire; refresh at most once every 30 s so a broken image can't loop.
        const now = Date.now();
        if (now - lastImageRefresh.current < 30_000) return;
        lastImageRefresh.current = now;
        void refresh();
      }}
    />
  );
}
