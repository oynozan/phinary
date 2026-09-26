import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
    title: "Not found",
};

export default function NotFound() {
    return (
        <div className="not-found">
            <h1>404</h1>
            <p>This page does not exist.</p>
            <Link href="/">Back to home</Link>
        </div>
    );
}
