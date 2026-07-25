"use client";

import { useEffect, useState } from "react";
import { Html5QrcodeScanner } from "html5-qrcode";

interface QRCameraScannerProps {
  onScanSuccess: (decodedText: string) => void;
}

export default function QRCameraScanner({ onScanSuccess }: QRCameraScannerProps) {
  const [isScanning, setIsScanning] = useState(true);

  useEffect(() => {
    // Para maiwasan ang multiple instances ng scanner
    const scanner = new Html5QrcodeScanner(
      "reader",
      { fps: 10, qrbox: { width: 250, height: 250 } },
      false
    );

    scanner.render(
      (decodedText) => {
        // Kapag may na-scan na QR Code, ipapasa natin ang text
        onScanSuccess(decodedText);
        
        // I-pause o i-stop muna ang scanner para hindi mag-multiple scan
        scanner.clear();
        setIsScanning(false);
      },
      (error) => {
        // Normal lang ang errors dito habang naghahanap ng QR code ang camera
        // Kaya hindi natin kailangan i-console.log lahat para hindi bumaha sa console
      }
    );

    // Cleanup function kapag umalis sa page ang user (para mamatay ang camera)
    return () => {
      scanner.clear().catch((error) => console.error("Failed to clear scanner", error));
    };
  }, [onScanSuccess]);

  return (
    <div className="w-full max-w-md mx-auto p-4 bg-white rounded-xl shadow-md">
      <h2 className="text-lg font-bold text-center mb-4 text-maroon-800">
        Align QR Code inside the frame
      </h2>
      
      {isScanning ? (
        <div id="reader" className="w-full"></div>
      ) : (
        <div className="text-center text-green-600 font-bold p-4 bg-green-50 rounded-lg">
          ✅ Scan Successful! Processing...
        </div>
      )}
    </div>
  );
}