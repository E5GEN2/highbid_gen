import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { pool } from './db';

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile) {
        // First sign-in: upsert user into DB
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
