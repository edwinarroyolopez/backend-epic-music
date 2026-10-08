import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { User } from '../src/models/user.model.js';

let mongo, server, base;
const secret = 'auth-regression-test-only';
const account = { username: 'auth_test', name: 'Synthetic', phone: 'auth-test-phone', email: 'auth@example.test', password: 'Synthetic-test-password' };
async function request(path, body, token) {
    const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}
before(async () => {
    process.env.JWT_SECRET = secret;
    process.env.JWT_EXPIRES_IN = '1h';
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'auth_isolated_test' });
    await User.init();
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    await mongo?.stop();
});

test('real signup/login/me, invalid credentials and duplicate registration', async () => {
    const signup = await request('/auth/signup', account);
    assert.equal(signup.status, 201);
    assert.equal(jwt.verify(signup.body.token, secret).sub, signup.body.user.id);
    const login = await request('/auth/login', { email: ` ${account.email.toUpperCase()} `, password: account.password });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.password, undefined);
    assert.equal((await request('/auth/me', undefined, login.body.token)).status, 200);
    assert.equal((await request('/auth/login', { email: account.email, password: 'Wrong-test-password' })).status, 401);
    assert.equal((await request('/auth/signup', account)).status, 409);
    for (const body of [{ email: {}, password: 'x' }, { email: account.email, password: {} }, { email: ' ', password: 'x' }, {}]) {
        assert.equal((await request('/auth/login', body)).status, 400);
    }
});

test('missing JWT secret and invalid lifetime are diagnosed without orphan registration or leaked secrets', async () => {
    for (const [secretValue, lifetime, reason] of [[undefined, '1h', 'JWT_SECRET_MISSING'], ['   ', '1h', 'JWT_SECRET_MISSING'], [secret, 'invalid-lifetime', 'JWT_EXPIRES_IN_INVALID']]) {
        try {
            if (secretValue === undefined) delete process.env.JWT_SECRET;
            else process.env.JWT_SECRET = secretValue;
            process.env.JWT_EXPIRES_IN = lifetime;
            const availability = await request('/auth/providers');
            assert.equal(availability.status, 200);
            assert.equal(availability.body.email, false);
            assert.equal(availability.body.emailUnavailableReason, reason);
            const count = await User.countDocuments();
            const signup = await request('/auth/signup', { ...account, email: 'not-created@example.test', phone: 'not-created', username: 'not_created' });
            assert.equal(signup.status, 503);
            assert.equal(signup.body.code, 'AUTH_UNAVAILABLE');
            assert.equal(await User.countDocuments(), count);
            const login = await request('/auth/login', { email: account.email, password: account.password });
            assert.equal(login.status, 503);
            assert.equal(login.body.code, 'AUTH_UNAVAILABLE');
            assert.equal(login.body.token, undefined);
            assert.ok(!JSON.stringify(login.body).includes(secret));
        } finally {
            process.env.JWT_SECRET = secret;
            process.env.JWT_EXPIRES_IN = '1h';
        }
    }
    assert.equal((await request('/auth/providers')).body.email, true);
    assert.equal((await request('/auth/login', { email: account.email, password: account.password })).status, 200);
});

test('legacy accounts with absent or invalid hash return 401, never 500 or plaintext login', async () => {
    for (const [index, value] of [undefined, null, 'plaintext-test-value'].entries()) {
        const email = `legacy${index}@example.test`;
        await User.collection.insertOne({ username: `legacy${index}`, name: 'Synthetic legacy', email, phone: `legacy${index}`, active: true, ...(value !== undefined && { password: value }) });
        const response = await request('/auth/login', { email, password: 'plaintext-test-value' });
        assert.equal(response.status, 401);
        assert.equal(response.body.token, undefined);
    }
});
