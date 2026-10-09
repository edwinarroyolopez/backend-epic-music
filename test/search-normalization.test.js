import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayText, identityKey, matchKey, resolveName, resolveGenre } from '../src/services/search-normalization.js';

const names = ['Mindless Self Indulgence', 'Beyoncé', 'AC/DC', 'Muse', 'Musa', 'Álma', 'Alma'].map(canonicalName => ({ canonicalName, aliases: [] }));
test('Unicode lookup preserves presentation and distinct identities, compounds and meaningful symbols', () => {
    assert.equal(displayText('  BEYONCE\u0301  '), 'BEYONCÉ');
    assert.equal(resolveName('  beyonce  ', names).value, 'Beyoncé');
    assert.equal(resolveName('mindless   SELF indulgence', names).value, 'Mindless Self Indulgence');
    assert.notEqual(identityKey('AC/DC'), identityKey('AC DC'));
    assert.notEqual(identityKey('Álma'), identityKey('Alma'));
    assert.notEqual(matchKey('+++'), matchKey(''));
    assert.equal(resolveName('ac dc', names).value, 'AC/DC');
});
test('controlled fuzzy, ambiguous homonyms, short and unusual legitimate inputs', () => {
    assert.equal(resolveName('Mindles Self Indulgence', names).value, 'Mindless Self Indulgence');
    assert.equal(resolveName('Mindles Self Indulgence', names).confidenceBand, 'high');
    assert.equal(resolveName('Musi', names).recognized, false);
    assert.deepEqual(resolveName('Musi', names).candidates.sort(), ['Musa', 'Muse']);
    assert.equal(resolveName('álma', names).value, 'Álma');
    assert.equal(resolveName('Àlma', names).recognized, false);
    assert.equal(resolveName('X Æ A-12', names).value, 'X Æ A-12');
    assert.equal(resolveName('Mindles Self Indulgence', names, { complete: false }).recognized, false);
    assert.equal(resolveName(undefined, names).value, null);
});
test('genre aliases and typos use open vocabulary without flattening hybrid genres', () => {
    assert.equal(resolveGenre('symphonic mettal').value, 'Symphonic Metal');
    assert.equal(resolveGenre('  METAL SINFÓNICO  ').value, 'Symphonic Metal');
    assert.equal(resolveGenre('Jazz / Post-Black Metal').value, 'Jazz / Post-Black Metal');
    assert.equal(resolveGenre('Jazz / Post-Black Metal').recognized, false);
});
