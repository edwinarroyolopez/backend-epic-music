import { User } from "../models/user.model.js"

const signupService = ({ user, pass, phone }) => {
    console.log(`Aqui mandamos user: ${user} - pass: ${pass} - phone: ${phone} a la DataBase`)
}

export const createUser = async (userData) => {

    const user = await User.create(userData);

    return user;
}
export {
    signupService
}