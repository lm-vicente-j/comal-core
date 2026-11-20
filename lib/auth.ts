// auth.ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { authConfig } from "@/app/auth.config";
import { authorizeCredentials } from "./auth-credentials";

export { authorizeCredentials };

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      authorize: authorizeCredentials,
    }),
  ],
});
