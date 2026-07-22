import type { User } from '../types/domain.js';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  email_verified_at?: Date | string | null;
  email_verification_required?: boolean;
  created_at: Date | string;
}

export interface PasswordCredentialRow {
  user_id: string;
  username: string;
  password_hash: string;
  last_login_at: Date | string | null;
  id: string;
  email: string;
  display_name: string;
  email_verified_at?: Date | string | null;
  email_verification_required?: boolean;
  created_at: Date | string;
}

export interface PasswordCredentialWithUser {
  user: User;
  username: string;
  passwordHash: string;
  lastLoginAt?: string;
  emailVerifiedAt?: string;
  emailVerificationRequired: boolean;
}
