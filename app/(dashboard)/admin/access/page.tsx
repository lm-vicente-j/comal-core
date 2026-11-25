import { redirect } from "next/navigation";
import { getCurrentAuthorization } from "@/lib/server-permissions";
import AccessManager from "./access-manager";

export default async function AccessPage() {
  const authorization = await getCurrentAuthorization();
  if (!authorization?.permissions["settings.manage"]) redirect("/pos");
  return <AccessManager />;
}
