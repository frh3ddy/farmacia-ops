import { searchTokens, substringMatchSql, fuzzyMatchSql, sortByIdOrder } from './product-search';

describe('searchTokens', () => {
  it('strips accents and case so "Frío" matches a query typed "frio"', () => {
    expect(searchTokens('Gel FRÍO')).toEqual(['gel', 'frio']);
  });

  it('splits on punctuation, and a number from its unit ("400mg" == "400 mg")', () => {
    expect(searchTokens('ibuprofeno/400mg, caja')).toEqual(['ibuprofeno', '400', 'mg', 'caja']);
  });

  it('keeps letter-led codes whole', () => {
    expect(searchTokens('IB400')).toEqual(['ib400']);
  });

  it('returns no tokens for a query with nothing searchable in it', () => {
    expect(searchTokens('   -- ')).toEqual([]);
  });

  it('caps a runaway query so the SQL stays bounded', () => {
    expect(searchTokens('a b c d e f g h')).toHaveLength(6);
  });
});

describe('substringMatchSql', () => {
  it('requires every token: words as substrings, numbers at a number boundary', () => {
    const sql = substringMatchSql(['ibupro', '400'], 'ibupro 400');
    expect(sql.values).toContain('%ibupro%');
    expect(sql.values).toContain('(^|[^0-9])400');
    expect(sql.values).not.toContain('%400%');
  });

  it('never falls back to trigrams — that is tier 2 only', () => {
    expect(substringMatchSql(['gel'], 'gel').sql).not.toContain('word_similarity');
  });
});

describe('fuzzyMatchSql', () => {
  it('allows a near-miss on a token long enough to have trigrams', () => {
    const sql = fuzzyMatchSql(['parasetamol'], 'parasetamol');
    expect(sql.sql).toContain('word_similarity');
    expect(sql.values).toContain(0.45);
  });

  it('demands an exact substring for short tokens, where similarity is noise', () => {
    const sql = fuzzyMatchSql(['gel', 'frio'], 'gel frio');
    // Only "frio" (4 chars) gets the fuzzy branch; "gel" stays a plain LIKE.
    expect(sql.sql.match(/word_similarity/g)?.length).toBe(2); // 1 token + the ORDER BY
  });
});

describe('sortByIdOrder', () => {
  it('restores SQL relevance order after Prisma refetches rows by id', () => {
    const rows = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    expect(sortByIdOrder(rows, ['a', 'b', 'c']).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});
