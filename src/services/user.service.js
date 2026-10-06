import { User } from "../models/user.model.js"

export const createUser = async (userData) => {

    const user = await User.create(userData);

    return user;
}
