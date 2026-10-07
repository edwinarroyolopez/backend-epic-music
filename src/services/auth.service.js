import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SALT_ROUNDS = 12;

export const hashPassword = async (password) => {
    return await bcrypt.hash(password, SALT_ROUNDS);
};


export const comparePassword = async (
    password,
    hashedPassword
) => {
    return await bcrypt.compare(
        password,
        hashedPassword
    );
};


export const generateToken = (user) => {

    if (!process.env.JWT_SECRET) {
        throw new Error(
            "JWT_SECRET no está configurado"
        );
    }

    return jwt.sign(
        {
            sub: user._id.toString(),
            username: user.username,
            email: user.email,
            phone: user.phone,
        },
        process.env.JWT_SECRET,
        {
            expiresIn:
                process.env.JWT_EXPIRES_IN || "7d"
        }
    );
};