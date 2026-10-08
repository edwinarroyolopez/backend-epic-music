import mongoose from "mongoose";

export const connectMongo = async () => {
    if (!process.env.MONGODB_URI?.trim()) {
        const error = new Error('MONGODB_URI no configurada');
        error.name = 'MongoConfigurationError';
        throw error;
    }
    await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
    });
    console.log('MongoDB conectado correctamente!');
}
