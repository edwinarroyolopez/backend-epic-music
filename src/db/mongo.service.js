import mongoose from "mongoose";

export const connectMongo = async () => {

    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("MongoDB conectado correctamente!")
    } catch (error) {
        console.log("Error conectando a MongoDB");
        console.error(error.name)
        process.exit(1);
    }

}
