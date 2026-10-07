import { User } from "../models/user.model.js"
import {
    hashPassword
} from "./auth.service.js";




export const createUser = async (userData) => {

    const {
        username,
        name,
        phone,
        email,
        password
    } = userData;


    const existingUser = await User.findOne({
        $or: [
            { email: email.toLowerCase() },
            { username },
            { phone }
        ]
    });


    if (existingUser) {
        throw new Error(
            "El usuario, email o teléfono ya está registrado"
        );
    }


    const hashedPassword =
        await hashPassword(password);


    const user = await User.create({
        username,
        name,
        phone,
        email: email.toLowerCase(),
        password: hashedPassword
    });


    return user;
};


export const findUserByEmail = async (email) => {

    return await User
        .findOne({
            email: email.toLowerCase()
        })
        .select("+password");
};


export const findUserById = async (id) => {

    return await User.findById(id);
};
