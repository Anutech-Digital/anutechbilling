/**
 * R-825: which existing people to suggest while a contact is being typed in.
 *
 * Matches on name AND email, because the operator may start with either — and the email
 * is the one that used to cause the collision, so typing an email that already exists
 * must surface the person who already holds it before the form is ever submitted.
 *
 * A name matches only when EVERY typed word starts a word of the contact's full name.
 * The old rule matched on ANY word, so "Utkarsh Sharma" suggested "Gautam Sharma" just
 * for sharing the surname — and the operator could link the wrong person.
 */

export type MatchableContact = {
  full_name: string | null;
  email: string | null;
};

const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);

/** Rank: lower is better. Null = no match. */
function rankOf(p: MatchableContact, nameWords: string[], emailQ: string): number | null {
  const fullName = words(p.full_name ?? "").join(" ");
  if (nameWords.length > 0 && fullName) {
    const query = nameWords.join(" ");
    const nameParts = fullName.split(" ");
    if (fullName === query) return 0;
    if (fullName.startsWith(query)) return 1;
    if (nameWords.every((w) => nameParts.some((part) => part.startsWith(w)))) return 2;
  }
  if (emailQ.length >= 3) {
    const email = (p.email ?? "").trim().toLowerCase();
    if (email && email.startsWith(emailQ)) return 3;
  }
  return null;
}

/**
 * People in `pool` matching the typed name and/or email, best first, at most `limit`.
 * Ranking: exact full name > name starts with the query > all words match > email match.
 */
export function matchContacts<T extends MatchableContact>(
  pool: readonly T[],
  name: string,
  email: string,
  limit = 6,
): T[] {
  let nameWords = words(name);
  let emailQ = email.trim().toLowerCase();
  /* An email typed into the name box still counts as an email. */
  if (!emailQ && nameWords.length === 1 && nameWords[0].includes("@")) {
    emailQ = nameWords[0];
    nameWords = [];
  }
  if (nameWords.join(" ").length < 2) nameWords = [];
  if (nameWords.length === 0 && emailQ.length < 3) return [];

  return pool
    .map((p, i) => ({ p, i, rank: rankOf(p, nameWords, emailQ) }))
    .filter((m): m is { p: T; i: number; rank: number } => m.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, limit)
    .map((m) => m.p);
}
