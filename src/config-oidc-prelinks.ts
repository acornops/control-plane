import { z } from 'zod';

const prelinkedIdentitySchema = z.object({
  subject: z.string().trim().min(1).max(512),
  email: z.string().trim().toLowerCase().email().max(320),
  displayName: z.string().trim().min(1).max(200),
  emailVerified: z.boolean()
}).strict();

const prelinkedIdentitiesSchema = z.array(prelinkedIdentitySchema).max(100).superRefine((identities, ctx) => {
  const subjects = new Set<string>();
  const emails = new Set<string>();
  identities.forEach((identity, index) => {
    if (subjects.has(identity.subject)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'subject'],
        message: 'OIDC prelinked subjects must be unique'
      });
    }
    if (emails.has(identity.email)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'email'],
        message: 'OIDC prelinked emails must be unique'
      });
    }
    subjects.add(identity.subject);
    emails.add(identity.email);
  });
});

export type OidcPrelinkedIdentity = z.infer<typeof prelinkedIdentitySchema>;

export function parseOidcPrelinkedIdentities(raw: string | undefined): OidcPrelinkedIdentity[] {
  let parsed: unknown = [];
  if (raw?.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('OIDC_PRELINKED_IDENTITIES_JSON must contain valid JSON');
    }
  }
  const result = prelinkedIdentitiesSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'prelinks'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid OIDC prelinked identities: ${detail}`);
  }
  return result.data;
}

export const oidcPrelinkedIdentitiesFromEnv = z.string().default('[]').transform((raw, ctx) => {
  try {
    return parseOidcPrelinkedIdentities(raw);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : 'Invalid OIDC prelinked identities'
    });
    return z.NEVER;
  }
});
