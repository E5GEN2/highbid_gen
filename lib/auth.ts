import NextAuth from 'next-auth';
import type { Provider } from 'next-auth/providers';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { pool } from './db';
import { verifyPassword } from './password';

// Providers. Credentials (email + password) is the primary in-house engine.
// Google stays configured but only registers when its env vars exist — so a
// suspended/removed Google project simply drops the provider instead of
// throwing, and it can be re-enabled later with a fresh project.
const providers: Provider[] = [];
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  );
}
providers.push(
  Credentials({
    name: 'credentials',
    credentials: {
      email: { label: 'Email', type: 'email' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(creds) {
      const email = String(creds?.email ?? '').trim().toLowerCase();
      const password = String(creds?.password ?? '');
      if (!email || !password) return null;
      const result = await pool.query(
        `SELECT id, email, name, image, password_hash FROM users WHERE LOWER(email) = $1`,
        [email],
      );
      const u = result.rows[0];
      if (!u || !u.password_hash) return null;
      const ok = await verifyPassword(password, u.password_hash);
      if (!ok) return null;
      return { id: u.id, email: u.email, name: u.name ?? null, image: u.image ?? null };
    },
  }),
);

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers,
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async jwt({ token, user, account, profile }) {
      // Credentials sign-in: authorize() returned our DB user; its id IS the
      // users.id, so carry it onto the token (same shape as the Google path).
      if (user?.id) {
        token.userId = user.id;
      }
      // Google OAuth first sign-in: upsert user into DB.
      if (account && profile) {
        const googleId = profile.sub!;
        const email = profile.email!;
        const name = profile.name ?? null;
        const image = profile.picture ?? null;

        const result = await pool.query(
          `INSERT INTO users (google_id, email, name, image)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (google_id) DO UPDATE SET
             email = EXCLUDED.email,
             name = EXCLUDED.name,
             image = EXCLUDED.image,
             updated_at = NOW()
           RETURNING id`,
          [googleId, email, name, image]
        );

        token.userId = result.rows[0].id;
        token.googleId = googleId;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.userId) {
        session.user.id = token.userId as string;
      }
      return session;
    },
  },
});
