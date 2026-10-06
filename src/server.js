import express from "express";
import dotenv from "dotenv";

import aiRoutes from "./routes/ai.routes.js";


import { loginController, signupController } from './controllers/user.controller.js';
import { connectMongo } from "./db/mongo.service.js";

dotenv.config();

const app = express();
app.use(express.json());

app.get('/', (request, response) => {
    response.send("<h2>Hola mundo</h2>")
})

app.post('/', (request, response) => {
    const { body } = request;

    console.log(body)

    response.send("datos: ", JSON.stringify(body))
})

app.get('/login', (request, response) => {
    loginController(request, response);
})

app.put('/signup', async (request, response) => {
    await signupController(request, response)
})



app.use("/ai", aiRoutes);

const startServer = async () => {

    await connectMongo();

    app.listen(7000, () => {
        console.log("Server is running on http://localhost:7000")
    })


}

startServer();


console.log("This is the server!");

