import {
    createUser,
    findUserByEmail
} from "../services/user.service.js";

import {
    comparePassword,
    generateToken
} from "../services/auth.service.js";


const signupController = async (req, res) => {

    try {

        const {
            username,
            name,
            phone,
            email,
            password
        } = req.body;


        if (
            !username ||
            !name ||
            !phone ||
            !email ||
            !password
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Todos los campos son obligatorios"
            });
        }


        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message:
                    "La contraseña debe tener mínimo 8 caracteres"
            });
        }


        const user = await createUser({
            username,
            name,
            phone,
            email,
            password
        });


        const token = generateToken(user);


        return res.status(201).json({
            success: true,

            message:
                "Usuario registrado correctamente",

            user: {
                id: user._id,
                username: user.username,
                name: user.name,
                email: user.email,
                phone: user.phone,
                active: user.active
            },

            token
        });


    } catch (error) {

        console.error(
            "Signup error:",
            error
        );


        if (error.code === 11000) {

            return res.status(409).json({
                success: false,
                message:
                    "El usuario ya está registrado"
            });

        }


        return res.status(500).json({
            success: false,
            message: error.message
        });

    }

};



const loginController = async (req, res) => {

    try {

        const {
            email,
            password
        } = req.body;


        if (!email || !password) {

            return res.status(400).json({
                success: false,
                message:
                    "Email y contraseña son obligatorios"
            });

        }


        const user =
            await findUserByEmail(email);


        if (!user) {

            return res.status(401).json({
                success: false,
                message:
                    "Credenciales incorrectas"
            });

        }


        if (!user.active) {

            return res.status(403).json({
                success: false,
                message:
                    "El usuario está desactivado"
            });

        }


        const passwordIsValid =
            await comparePassword(
                password,
                user.password
            );


        if (!passwordIsValid) {

            return res.status(401).json({
                success: false,
                message:
                    "Credenciales incorrectas"
            });

        }


        const token =
            generateToken(user);


        return res.status(200).json({
            success: true,

            message:
                "Login exitoso",

            user: {
                id: user._id,
                username: user.username,
                name: user.name,
                email: user.email,
                phone: user.phone,
                active: user.active
            },

            token
        });


    } catch (error) {

        console.error(
            "Login error:",
            error
        );


        return res.status(500).json({
            success: false,
            message:
                "Error interno del servidor"
        });

    }

};



export {
    loginController,
    signupController
};