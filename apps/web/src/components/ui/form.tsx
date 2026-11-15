import type { InputHTMLAttributes, LabelHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const fieldBase =
  "w-full rounded-xl border bg-white px-3 py-2.5 text-base text-slate-900 placeholder:text-slate-400 min-h-11";

export function Label({ className, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1 block text-sm font-semibold text-slate-800", className)} {...rest} />;
}

export function Input({
  className,
  invalid,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(fieldBase, invalid ? "border-red-600" : "border-slate-300", className)}
      {...rest}
    />
  );
}

export function Textarea({
  className,
  invalid,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(fieldBase, "min-h-24", invalid ? "border-red-600" : "border-slate-300", className)}
      {...rest}
    />
  );
}

/** Label + control + hint/error wrapper. `id` links label and message. */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-msg`} role="alert" className="mt-1 text-sm font-medium text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className="mt-1 text-sm text-slate-600">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
