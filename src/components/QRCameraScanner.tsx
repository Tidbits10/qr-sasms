"use client";

import { useEffect, useState } from "react";
import { Html5QrcodeScanner } from "html5-qrcode";

interface QRCameraScannerProps {
  onScanSuccess: (decodedText: string) => void;
}

export default function QRCameraScanner({ onScanSuccess }: QRCameraScannerProps) {
  const [isScanning, setIsScanning] = useState(true);

  useEffect(() => {
    
    const scanner = new Html5QrcodeScanner(
      "reader",
      { fps: 10, qrbox: { width: 250, height: 250 } },
      false
    );

    scanner.render(
      (decodedText) => {
        
        onScanSuccess(decodedText);
        
        
        scanner.clear();
        setIsScanning(false);
      },
      (error) => {
        
        
      }
    );

    
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