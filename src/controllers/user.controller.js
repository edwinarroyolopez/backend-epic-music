import { createUser } from "../services/user.service.js";

const loginController = (req, res) => {
    console.log("Login Controller")
    const { query } = req
    const { user } = query

    console.log({ query });

    console.log({ user })

    if (user === "sam") {
        res.send('<h2 style="color:#0F0">Hola Sam, bienvenida a tu sesión!</h2>')
    } else {
        res.send(`<h2 style="color:#F00">El usuario ${user} no existe</h2>`)
    }

}

const signupController = async (req, res) => {

    const { body } = req;
    const { username, password, phone, email } = body

    const user = await
        createUser({ username, password, phone, email });

    res.json(user)

}

export {
    loginController,
    signupController
}