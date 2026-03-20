import { Suspense } from "react";
import ResetClient from "./ResetClient";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<p className="px-6 py-16 text-sm text-muted-foreground">Загрузка…</p>}>
      <ResetClient />
    </Suspense>
  );
}
