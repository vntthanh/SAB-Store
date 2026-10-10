import React from 'react';
import { Link } from 'react-router-dom';
import usePublicSettings from '../hooks/usePublicSettings';

const Footer = () => {
  const settings = usePublicSettings();
  const contactEmail = settings?.contactEmail;
  const contactFacebookUrl = settings?.contactFacebookUrl;

  return (
    <footer className="bg-gray-800 text-white mt-12">
      <div className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Quick Links */}
          <div>
            <h4 className="text-lg font-semibold mb-4">Liên kết nhanh</h4>
            <div className="space-y-2">
              <Link 
                to="/" 
                className="block text-gray-300 hover:text-white transition-colors"
              >
                Trang chủ
              </Link>
              <Link 
                to="/order-tracking" 
                className="block text-gray-300 hover:text-white transition-colors"
              >
                Tra cứu đơn hàng
              </Link>
            </div>
          </div>

          {/* Contact Info: each line is hidden when the admin leaves it empty */}
          {(contactEmail || contactFacebookUrl) && (
            <div>
              <h4 className="text-lg font-semibold mb-4">Thông tin liên hệ</h4>
              <div className="space-y-2 text-gray-300">
                {contactEmail && (
                  <div className="flex items-center space-x-2">
                    <i className="fas fa-envelope text-primary-400"></i>
                    <span><a href={`mailto:${contactEmail}`}>{contactEmail}</a></span>
                  </div>
                )}
                {contactFacebookUrl && (
                  <div className="flex items-center space-x-2">
                    <i className="fab fa-facebook-f text-primary-400"></i>
                    <span><a href={contactFacebookUrl} target="_blank" rel="noopener noreferrer">Facebook Page</a></span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </footer>
  );
};

export default Footer;
