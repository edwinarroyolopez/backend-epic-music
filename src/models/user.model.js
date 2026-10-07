import mongoose from "mongoose"

const userSchema = new mongoose.Schema(
    {
        username: {
            type: String,
            unique: true,
            required: true
        },

        name: {
            type: String,
            required: true
        },

        email: {
            type: String,
            unique: true,
            required: true
        },

        password: {
            type: String,
            required: true,
            select: false
        },

        phone: {
            type: String,
            unique: true,
            required: true
        },

        active: {
            type: Boolean,
            default: true
        },

    },
    {
        timestamps: true
    }

);
export const User = mongoose.model("User", userSchema);