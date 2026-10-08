import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SALT_ROUNDS = 12;

export class AuthConfigurationError extends Error {
    constructor(reason) {
        super('El inicio de sesión no está disponible por configuración del servidor');
        this.name = 'AuthConfigurationError';
        this.code = 'AUTH_UNAVAILABLE';
        this.reason = reason;
    }
}

export function getTokenConfiguration() {
    const secret = process.env.JWT_SECRET;
    if (typeof secret !== 'string' || !secret.trim()) {
        throw new AuthConfigurationError('JWT_SECRET_MISSING');
    }
    const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
    // Let the JWT library validate its own duration grammar. This temporary
    // token is never returned, persisted or logged; no fallback secret is used.
    try { jwt.sign({}, secret, { expiresIn }); }
    catch { throw new AuthConfigurationError('JWT_EXPIRES_IN_INVALID'); }
    return { secret, expiresIn };
}

export function getAuthAvailability() {
    try {
        getTokenConfiguration();
        return { email: true };
    } catch (error) {
        if (!(error instanceof AuthConfigurationError)) throw error;
        return { email: false, emailUnavailableReason: error.reason };
    }
}

export const hashPassword = async (password) => {
    return await bcrypt.hash(password, SALT_ROUNDS);
};


export const comparePassword = async (
    password,
    hashedPassword
) => {
    // Old/incomplete accounts must fail authentication, never bypass hashing
    // or throw a 500 because bcrypt received undefined instead of a hash.
    if (typeof password !== 'string' || typeof hashedPassword !== 'string' ||
        !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hashedPassword)) return false;
    return await bcrypt.compare(
        password,
        hashedPassword
    );
};


export const generateToken = (user) => {
    const { secret, expiresIn } = getTokenConfiguration();

    return jwt.sign(
        {
            sub: user._id.toString(),
            username: user.username,
            email: user.email,
            phone: user.phone,
        },
        secret,
        { expiresIn }
    );
};
