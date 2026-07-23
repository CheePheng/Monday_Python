import { createContext, useCallback, useContext, useState } from "react";
import ConfirmDialog from "./views/ConfirmDialog";
import type { ConfirmOptions } from "./lib/confirm";

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

// Default DENIES rather than allows: if the provider is ever missing, a destructive action must not sail
// through unconfirmed. It's loud in the console so the wiring mistake is obvious.
const Ctx = createContext<ConfirmFn>(async opts => {
  console.error("useConfirm() used outside <ConfirmProvider> — denying:", opts.title);
  return false;
});

/** `const confirm = useConfirm()` → `if (!(await confirm({...}))) return;` */
export function useConfirm(): ConfirmFn { return useContext(Ctx); }

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<{ opts: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);

  const confirm = useCallback<ConfirmFn>(opts => new Promise<boolean>(resolve => {
    // One dialog at a time. A second ask while one is open resolves the older as cancelled rather than
    // stranding its promise (which would hang the caller's await forever). Resolving inside the updater is
    // safe under StrictMode's double-invocation because resolving a settled promise is a no-op.
    setPending(prev => { prev?.resolve(false); return { opts, resolve }; });
  }), []);

  const done = useCallback((ok: boolean) => {
    setPending(prev => { prev?.resolve(ok); return null; });
  }, []);

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {pending && <ConfirmDialog opts={pending.opts} onDone={done} />}
    </Ctx.Provider>
  );
}
