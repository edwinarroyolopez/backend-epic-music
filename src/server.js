import express from "express";

const app = express();

app.get('/', (request, response) => {
    console.log("Hola mundo!");
    response.send("<h2>Hola mundo</h2>")
})

app.get('/login', (request, response) => {
    response.send("<h2>Esta es la página de login</h2>")
})

app.get('/signup', (request, response) => {
    response.send("<h2>Esta es la página de registro</h2>")
})

app.listen(7000, () => {
    console.log("Server is running on http://localhost:7000")
})




console.log("This is the server!");

