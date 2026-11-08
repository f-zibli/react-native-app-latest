import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';

import { auth } from './firebase';

// Register a new account
export async function registerUser(
  email: string,
  password: string
) {
  const credential = await createUserWithEmailAndPassword(
    auth,
    email,
    password
  );

  return {
    user_id: credential.user.uid,
    email: credential.user.email,
  };
}

// Login
export async function loginUser(
  email: string,
  password: string
) {
  const credential = await signInWithEmailAndPassword(
    auth,
    email,
    password
  );

  return {
    user_id: credential.user.uid,
    email: credential.user.email,
  };
}

// Logout
export async function logoutUser() {
  await signOut(auth);
}