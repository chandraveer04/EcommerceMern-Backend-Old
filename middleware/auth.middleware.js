import jwt from "jsonwebtoken";
import User from "../models/user.model.js";


export const protectedRoute = async (req, res, next) => {
    try {
        const accessToken = req.cookies.accessToken;
        if (!accessToken) {
            return res.status(401).json({ message: "User not authenticated- No access token" });
        }
       try {
        const decoded = jwt.verify(accessToken, process.env.ACCESS_TOKEN_SECRET);
        const user = await User.findById(decoded.userId).select("-password");
        if(!user){
            return res.status(401).json({ message: "User not authenticated- No user found" });
        }  
        req.user = user;
        next(); 
       } catch (error) {
        if (error.name === "TokenExpiredError") {
            return res.status(401).json({ message: "User not authenticated- Token expired" });
        }
        throw error; 
       }
    } catch (error) {
        console.log("Error in protectedRoute middleware", error.message);
        res.status(500).json({message: "Unauthorized- Server errori Invalid access token", error: error.message});
    }
};


export const adminRoute = async (req, res, next) => {
    try {
        if (req.user && req.user.role === "admin") {
            next();
        } else {
            res.status(403).json({ message: "Access Denied- Not an admin" });
        }
    } catch (error) {
        console.log("Error in adminRoute middleware", error.message);
        res.status(500).json({ message: "Unauthorized- Server error", error: error.message });
    }
};