import type { Metadata } from "next";
import "./globals.css";
import "@livekit/components-styles";

export const metadata: Metadata = {
  title: "Race Innovations — Video Calling & Chat",
  description:
    "Race Innovations — a video calling and chat app built with Next.js + LiveKit",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {/* Apply the saved accent theme before paint to avoid a flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m={Black:['24 24 27','9 9 11','0 0 0'],Purple:['91 95 199','79 82 178','68 71 145'],Blue:['37 99 235','29 78 216','30 58 138'],Teal:['13 148 136','15 118 110','17 94 89'],Green:['22 163 74','21 128 61','22 101 52'],Orange:['234 88 12','194 65 12','154 52 18'],Rose:['225 29 72','190 18 60','159 18 57'],Slate:['51 65 85','30 41 59','15 23 42']};var t=localStorage.getItem('meetup-theme');if(t&&m[t]){var r=document.documentElement;r.style.setProperty('--accent',m[t][0]);r.style.setProperty('--accent-dark',m[t][1]);r.style.setProperty('--accent-darker',m[t][2]);}}catch(e){}})();`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
