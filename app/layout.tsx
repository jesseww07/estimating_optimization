import type { Metadata } from "next";
import { Cardo, Playfair_Display } from "next/font/google";
import "./globals.css";

const playfair = Playfair_Display({
    variable: "--font-playfair",
    subsets: ["latin"],
    weight: ["600", "700"],
});

const cardo = Cardo({
    variable: "--font-cardo",
    subsets: ["latin"],
    weight: ["400", "700"],
    style: ["normal", "italic"],
});

export const metadata: Metadata = {
    title: "Premier Lighting — VE Estimator",
    description: "Value-engineering substitution recommendations for the estimating team.",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" className={`${playfair.variable} ${cardo.variable} h-full antialiased`}>
            <body className="min-h-full flex flex-col">{children}</body>
        </html>
    );
}
