import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBV8DHWOqsBs8a57WKvJ_-e_k_VpdHOcIc",
  authDomain: "health-app-18bcc.firebaseapp.com",
  projectId: "health-app-18bcc",
  storageBucket: "health-app-18bcc.firebasestorage.app",
  messagingSenderId: "1040049150102",
  appId: "1:1040049150102:web:72d022f9c01a63801b4ab7"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);