import Link from "next/link";

export default function NotFound() {
    return (
        <div className="page-container text-center">
            <header className="page-head">
                <h1>Nothing here</h1>
            </header>
            <Link href="/" className="page-action">
                Back to markets
            </Link>
        </div>
    );
}
