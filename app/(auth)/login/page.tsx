import { getSetupStatus } from "@/lib/actions/setup";
import LoginExperience from "./login-experience";

// Installation eligibility must be evaluated at request time, never at build time.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const setup = await getSetupStatus();
  return <LoginExperience setupAvailable={setup.available} />;
}
