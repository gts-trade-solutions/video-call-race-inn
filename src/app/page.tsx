import { redirect } from "next/navigation";

// The root just routes to the dashboard; middleware bounces guests to /login.
export default function Home() {
  redirect("/dashboard");
}
