import {
    createUser,
    findUserByEmail
} from "../services/user.service.js";

import {
    comparePassword,
    generateToken,
    getTokenConfiguration,
    AuthConfigurationError
} from "../services/auth.service.js";


const signupController = async (req, res) => {

    try {

        const {
            username,
            name,
            phone,
            email,
            password
        } = req.body ?? {};


        if (
            [username, name, phone, email, password].some(value => typeof value !== 'string' || !value.trim())
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


        // Validate JWT before writing a user, avoiding failed registrations
        // that silently leave an account behind when signing is unavailable.
        getTokenConfiguration();
        const user = await createUser({
            username,
            name,
            phone,
            email: email.trim(),
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

        if (error instanceof AuthConfigurationError) {
            console.error(`Signup unavailable: ${error.reason}`);
            return res.status(503).json({ success: false, code: error.code, message: error.message });
        }

        console.error(
            "Signup error:",
            error.name
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
            message: 'Error interno del servidor'
        });

    }

};



const loginController = async (req, res) => {
    let phase = 'validation';

    try {

        const {
            email,
            password
        } = req.body ?? {};


        if ([email, password].some(value => typeof value !== 'string' || !value.trim())) {

            return res.status(400).json({
                success: false,
                message:
                    "Email y contraseña son obligatorios"
            });

        }


        getTokenConfiguration();
        phase = 'lookup';
        const user =
            await findUserByEmail(email.trim());


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


        phase = 'verify_password';
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


        phase = 'sign_token';
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

        if (error instanceof AuthConfigurationError) {
            console.error(`Login unavailable: ${error.reason}`);
            return res.status(503).json({ success: false, code: error.code, message: error.message });
        }

        console.error(
            `Login error: phase=${phase}`,
            error.name
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
